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
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

# Must be set before torch or onnxruntime are imported. Both size their thread
# pools from the host's CPU count, which on a container platform is far larger
# than the slice we actually get — they then fail to spawn threads with
# "Resource temporarily unavailable".
THREADS = os.environ.get("NUM_THREADS", "2")
os.environ.setdefault("OMP_NUM_THREADS", THREADS)
os.environ.setdefault("MKL_NUM_THREADS", THREADS)
os.environ.setdefault("OPENBLAS_NUM_THREADS", THREADS)

import requests

API_URL = os.environ.get("API_URL", "").rstrip("/")
EMAIL = os.environ.get("WORKER_EMAIL", "")
PASSWORD = os.environ.get("WORKER_PASSWORD", "")
DEFAULT_LANG = os.environ.get("LANG_CODE", "kok")
DECODER = os.environ.get("DECODER", "ctc")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))
WAKE_PORT = int(os.environ.get("PORT", "8080"))

# Set by the wake endpoint so an upload is picked up immediately. Polling
# stays as the fallback — a missed ping must not strand a recording.
wake_event = threading.Event()
MODEL_ID = os.environ.get("MODEL_ID", "ai4bharat/indic-conformer-600m-multilingual")
GOOGLE_KEY = os.environ.get("GOOGLE_SPEECH_API_KEY", "")

# English is not one of the 22 languages IndicConformer covers, so it goes to
# Google Speech-to-Text instead. No model load, and far better accuracy.
GOOGLE_LANGS = {"en": "en-US", "en-US": "en-US", "en-IN": "en-IN"}

_running = True


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def handle_stop(signum, frame):
    global _running
    log(f"Signal {signum} received, finishing current work then exiting.")
    _running = False


signal.signal(signal.SIGTERM, handle_stop)
signal.signal(signal.SIGINT, handle_stop)


class WakeHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        wake_event.set()
        self.send_response(202)
        self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass  # the worker does its own logging


class WakeServer(HTTPServer):
    # Railway's private network is IPv6 only, so binding to 0.0.0.0 would
    # leave the backend unable to reach this.
    address_family = socket.AF_INET6


def start_wake_server():
    try:
        server = WakeServer(("::", WAKE_PORT), WakeHandler)
    except Exception as err:
        log(f"Wake endpoint unavailable ({err}); polling only")
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"Wake endpoint listening on port {WAKE_PORT}")


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


def _cap_onnxruntime_threads(threads):
    """Force every ONNX Runtime session to a small, fixed thread pool.

    ORT sizes its pool from the host's core count and ignores OMP_NUM_THREADS.
    On a container that means it tries to spawn far more threads than the
    cgroup allows and dies with "Resource temporarily unavailable". The model
    builds its own sessions internally, so the only place to intervene is the
    InferenceSession constructor itself.
    """
    import onnxruntime as ort

    original = ort.InferenceSession

    class CappedSession(original):
        def __init__(self, *args, **kwargs):
            opts = kwargs.get("sess_options")
            positional = len(args) > 1 and isinstance(args[1], ort.SessionOptions)
            if positional:
                opts = args[1]
            if opts is None:
                opts = ort.SessionOptions()

            opts.intra_op_num_threads = threads
            opts.inter_op_num_threads = 1
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL

            if positional:
                args = args[:1] + (opts,) + args[2:]
            else:
                kwargs["sess_options"] = opts

            super().__init__(*args, **kwargs)

    ort.InferenceSession = CappedSession
    log(f"ONNX Runtime sessions capped at {threads} thread(s)")


def load_model():
    import torch
    from transformers import AutoModel

    torch.set_num_threads(int(THREADS))
    _cap_onnxruntime_threads(int(THREADS))

    log(f"Loading model... (threads={THREADS})")
    t0 = time.time()
    model = AutoModel.from_pretrained(MODEL_ID, trust_remote_code=True)
    log(f"Model ready in {time.time() - t0:.0f}s")
    return model, torch


def transcribe_google(path, language_code):
    """Google Speech-to-Text. Chunks the audio because the synchronous
    endpoint caps out around 60 seconds and recipes run longer."""
    import io
    import soundfile as sf

    if not GOOGLE_KEY:
        raise RuntimeError("GOOGLE_SPEECH_API_KEY not set on this service")

    data, sr = sf.read(path, dtype="int16", always_2d=True)
    mono = data[:, 0]
    span = 50 * sr  # comfortably under the limit
    pieces = []

    for start in range(0, len(mono), span):
        segment = mono[start:start + span]
        if len(segment) < sr // 2:  # skip a sliver at the end
            continue

        buf = io.BytesIO()
        sf.write(buf, segment, sr, format="WAV", subtype="PCM_16")
        encoded = base64.b64encode(buf.getvalue()).decode("ascii")

        resp = requests.post(
            f"https://speech.googleapis.com/v1/speech:recognize?key={GOOGLE_KEY}",
            json={
                "config": {
                    "encoding": "LINEAR16",
                    "sampleRateHertz": sr,
                    "languageCode": language_code,
                    "enableAutomaticPunctuation": True,
                },
                "audio": {"content": encoded},
            },
            timeout=180,
        )
        resp.raise_for_status()

        for result in resp.json().get("results", []):
            alternatives = result.get("alternatives") or []
            if alternatives:
                pieces.append(alternatives[0].get("transcript", "").strip())

    return " ".join(p for p in pieces if p)


def transcribe(model, torch, path, lang):
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
        return model(wav, lang, DECODER)


def process_queue(headers):
    """Drain the queue. Returns the number of recordings handled."""
    r = requests.get(f"{API_URL}/audio/queue/pending", headers=headers, timeout=30)
    r.raise_for_status()
    queue = r.json()

    if not queue:
        return 0

    log(f"{len(queue)} recording(s) pending")

    # Loaded on first use. A queue of only English recordings never pays for it.
    model = None
    torch = None
    done = 0

    try:
        for item in queue:
            if not _running:
                break

            audio_id = item["id"]
            log(
                f"[{audio_id}] {item.get('title', '?')} "
                f"({item.get('duration_seconds')}s, {item.get('language') or DEFAULT_LANG})"
            )
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

                # Each recording carries the language chosen when it was
                # recorded. Falling back to the global default only matters
                # for rows saved before the picker existed.
                lang = item.get("language") or DEFAULT_LANG
                t0 = time.time()

                if lang in GOOGLE_LANGS:
                    text = transcribe_google(tmp_path, GOOGLE_LANGS[lang])
                else:
                    if model is None:
                        model, torch = load_model()
                    text = transcribe(model, torch, tmp_path, lang)
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
        if model is not None:
            # Release it so idle memory drops back to ~150 MB.
            del model
            gc.collect()
            log("Model released")

    return done


def main():
    check_config()
    log(f"Worker starting. Polling {API_URL} every {POLL_SECONDS}s. default lang={DEFAULT_LANG} decoder={DECODER}")
    start_wake_server()

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

        # Returns early when the backend pings /wake after an upload.
        if wake_event.wait(timeout=POLL_SECONDS):
            wake_event.clear()
            log("Woken by upload")

    log("Worker stopped.")


if __name__ == "__main__":
    main()
    # ONNX Runtime can segfault during interpreter teardown. All work is
    # already committed, so skip destructors.
    sys.stdout.flush()
    os._exit(0)
