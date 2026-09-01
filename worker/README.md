# Transcription worker

Polls the recipe backend for recordings awaiting transcription, runs
AI4Bharat IndicConformer (MIT, CPU/ONNX), and writes transcripts back.
The backend then parses the transcript into ingredients and steps.

## Railway setup

Create a **new service** in the same Railway project, from this same GitHub
repo, with:

- **Root Directory:** `worker`
- **Volume:** mount at `/data` (5 GB is plenty)

### Environment variables

| Variable | Value |
|---|---|
| `API_URL` | the backend's public Railway URL |
| `WORKER_EMAIL` | an app login email |
| `WORKER_PASSWORD` | that account's password |
| `LANG_CODE` | `kok` (try `gom` if that errors) |
| `DECODER` | `ctc` or `rnnt` |
| `POLL_SECONDS` | `60` |
| `HF_HOME` | `/data/huggingface` |
| `HF_TOKEN` | a Hugging Face read token |

`HF_HOME` on the volume matters: without it the 2.5 GB model re-downloads
every time the container restarts.

`HF_TOKEN` is required because the model repo is gated.

Raise the service memory limit to at least 4 GB in service settings. The
model needs roughly 3 GB while transcribing; the worker idles near 150 MB
because it releases the model between batches.
