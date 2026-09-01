#!/usr/bin/env python3
"""
Transcription worker for the family recipe app.

Runs continuously on Railway. Polls the backend for recordings awaiting
transcription, runs AI4Bharat IndicConformer on CPU, writes transcripts back.

The model is loaded only when there is work and released afterwards. Railway
bills actual memory per second, so an idle worker sitting at ~150 MB costs
very little; holding 3 GB of model permanently would not.

Configuration comes from environment variables set in the Railway service.
"""

import base64
import gc
import os
import signal
import sys
import tempfile
import time

import requests

API_URL = os.environ.get("API_URL", "").rstrip("/")
EMAIL = os.environ.get("WORKER_EMAIL", "")
PASSWORD = os.environ.get("WORKER_PASSWORD", "")
LANG = os.environ.get("LANG_CODE", "kok")
DECODER = os.environ.get("DECODER", "ctc")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))
MODEL_ID = os.environ.get("MODEL_ID", "ai4bharat/indic-conformer-600m-multilingual")

_running = True


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def handle_stop(signum, frame):
    global _running
    log(f"Signal {signum} received, finishing current work then exiting.")
    _running = False


signal.signal(signal.SIGTERM, handle_stop)
signal.signal(signal.SIGINT, handle_stop)


def check_config():
    missing = [
        name
        for name, val in (("API_URL", API_URL), ("WORKER_EMAIL", EMAIL), ("WORKER_PASSWORD", PASSWORD))
        if not val
    ]
    if missing:
        log(f"Missing environment variables: {', '.join(missing)}")
        sys.exit(1)


def login():
    r = requests.post(
        f"{API_URL}/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=30
    )
    r.raise_for_status()
    token = r.json().get("auth_token")
    if not token:
        raise RuntimeError("Login returned no auth_token")
    return token


def load_model():
    import torch
    from transformers import AutoModel

    log("Loading model...")
    t0 = time.time()
    model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
    log(f"Model ready in {time.time() - t0:.0f}s")
    return model, torch


def transcribe(model, torch, path):
    # soundfile rather than torchaudio.load: recent torchaudio delegates
    # decoding to TorchCodec. The app always writes 16 kHz mono PCM WAV.
    import soundfile as sf

    data, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.T)
    wav = torch.mean(wav, dim=0, keepdim=True)

    if sr != 16000:
        import torchaudio
        wav = torchaudio.transforms.Resample(orig_freq=sr, new_freq=16000)(wav)

    with torch.no_grad():
        return model(wav, LANG, DECODER)


def process_queue(headers):
    """Drain the queue. Returns the number of recordings handled."""
    r = requests.get(f"{API_URL}/audio/queue/pending", headers=headers, timeout=30)
    r.raise_for_status()
    queue = r.json()

    if not queue:
        return 0

    log(f"{len(queue)} recording(s) pending")
    model, torch = load_model()
    done = 0

    try:
        for item in queue:
            if not _running:
                break

            audio_id = item["id"]
            log(f"[{audio_id}] {item.get('title', '?')} ({item.get('duration_seconds')}s)")
            tmp_path = None

            try:
                fr = requests.get(f"{API_URL}/audio/file/{audio_id}", headers=headers, timeout=180)
                fr.raise_for_status()
                audio_b64 = fr.json()["audio_data"]
                if "," in audio_b64[:64]:
                    audio_b64 = audio_b64.split(",", 1)[1]

                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp.write(base64.b64decode(audio_b64))
                    tmp_path = tmp.name

                t0 = time.time()
                text = transcribe(model, torch, tmp_path)
                log(f"  {time.time() - t0:.0f}s -> {text[:120]}")

                pr = requests.patch(
                    f"{API_URL}/audio/{audio_id}/transcript",
                    headers=headers,
                    json={"transcript": text},
                    timeout=120,
                )
                pr.raise_for_status()
                body = pr.json()
                log(
                    f"  saved: {body.get('parsed_ingredients', 0)} ingredients, "
                    f"{body.get('parsed_steps', 0)} steps"
                )
                done += 1

            except Exception as err:
                log(f"  FAILED: {err}")
                try:
                    requests.patch(
                        f"{API_URL}/audio/{audio_id}/transcript",
                        headers=headers,
                        json={"error_message": str(err)[:500]},
                        timeout=30,
                    )
                except Exception:
                    pass

            finally:
                if tmp_path and os.path.exists(tmp_path):
                    os.unlink(tmp_path)

    finally:
        # Release the model so idle memory drops back to ~150 MB.
        del model
        gc.collect()
        log("Model released")

    return done


def main():
    check_config()
    log(f"Worker starting. Polling {API_URL} every {POLL_SECONDS}s. lang={LANG} decoder={DECODER}")

    token = None
    headers = {}

    while _running:
        try:
            if token is None:
                token = login()
                headers = {"Authorization": f"Bearer {token}"}
                log("Logged in")

            process_queue(headers)

        except requests.HTTPError as err:
            status = err.response.status_code if err.response is not None else None
            if status == 401:
                log("Token rejected, logging in again next cycle")
                token = None
            else:
                log(f"HTTP error: {err}")
        except Exception as err:
            log(f"Error: {err}")

        for _ in range(POLL_SECONDS):
            if not _running:
                break
            time.sleep(1)

    log("Worker stopped.")


if __name__ == "__main__":
    main()
    # ONNX Runtime can segfault during interpreter teardown. All work is
    # already committed, so skip destructors.
    sys.stdout.flush()
    os._exit(0)
