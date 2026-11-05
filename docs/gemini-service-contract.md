# Gemini server contract

The web/mobile client sends requests to the same-origin `/api/gemini/*` endpoints. The server verifies the Firebase ID token before calling Gemini. Requests without a valid signed-in user are rejected.

## Independent project configuration

Configure up to six independent Google API keys in the server-only `GEMINI_API_KEYS` environment variable. In this deployment, each key is from a different Google account/project:

```env
GEMINI_API_KEYS=key-from-account-1,key-from-account-2,key-from-account-3,key-from-account-4,key-from-account-5,key-from-account-6
```

Do not put Gemini keys in `VITE_*` variables, client storage, request bodies, logs, or responses.

The unused client-side Gemini key pool has been removed. On startup, the app also clears its legacy `stk_gemini_api_keys_pool` entry from secure storage, Preferences, and localStorage.

## Quota-aware scheduling

The scheduler tracks quota separately for each key and model, rotates across keys, and enforces a three-call concurrency ceiling per key and model. OCR tries `gemini-3.5-flash-lite` first; only if that call fails does it try `gemini-3.1-flash-lite` using the same key. Both model attempts are charged to their own RPM/RPD counters. If both attempts fail, that key is paused for 10 seconds and the OCR batch is retried using another key. Provider 429 responses additionally cool down the affected key-model, and daily-quota responses exhaust that key-model until the next UTC day. Invalid requests and other provider failures are reported rather than silently treated as success.

Configured per-project limits and in-process concurrency:

| Task | Model order | RPM / RPD per project and model | Max active calls |
|---|---|---:|---:|
| Digitization/OCR | `gemini-3.5-flash-lite` (primary), `gemini-3.1-flash-lite` (same-key fallback) | 15 / 500 per model | 3 per key and model |
| Analysis/assistant | `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3-flash` | 5 / 20 | 2 |

These are configured scheduler ceilings based on the supplied quotas, not a guarantee from Google that every project has those limits. Provider 429 responses remain authoritative. The daily ledger and concurrency controls currently live in one server process and reset on process restart; they are not shared across multiple replicas. Do not horizontally scale this server until the scheduler is backed by a shared quota store/lease (for example Redis or a transactional database) and daily usage persistence.

The server also limits each Firebase user to 20 API requests per minute. Document uploads are limited to 25 MB; JSON parsing allows 36 MB for base64 expansion. Analysis calls have a bounded total wait, per-attempt timeout, and SSE heartbeats for the streaming assistant.

## OCR and multi-page PDFs

The client saves the original document to Drive and sends the PDF to the server. PDFs are split server-side into batches of up to three pages, with at most six OCR batches running concurrently per request. A PDF may contain up to 60 pages. Each batch is routed independently through the same quota scheduler; successful batch results are merged in page order with page-specific notes and de-duplicated diagnoses, medications, and metrics. The merged result remains one reviewable timeline event per source file.

Progress SSE reports completed page ranges and quota/model activity. A heartbeat is sent while Gemini is working. The total OCR request is limited to five minutes; each provider attempt is limited to 45 seconds. If a batch ultimately fails, the overall extraction fails explicitly and the original Drive file remains available for retry/manual entry. Multiple selected files still wait for the user to save or skip each review before the next file starts.

The server's in-flight work and quota counters are process-local, not durable or shared across replicas. The client stores only the Drive file ID, progress percentage, and status in localStorage; it never stores document bytes, extracted medical data, access tokens, or Gemini keys there. After a reload, the UI offers to download the original from Drive and rerun OCR; it cannot attach to or continue the original server request. Browser-selected files still waiting in the upload queue are not persisted. Durable server jobs and shared quota accounting require a backend job/quota store, which is not configured in this deployment.

## Requests

Extraction:

```json
{
  "base64Data": "...",
  "mimeType": "application/pdf",
  "member": { "id": "member-id", "name": "Member name" },
  "stream": true
}
```

A successful streamed extraction emits `progress` and `complete` messages. Progress updates may include a partial merged extraction. Errors after the stream starts use an `error` message. Non-streaming endpoints return JSON with `success: true` or a non-2xx response containing `{ "error": "..." }`.

The client must show extracted values for human review and must not treat a model response as a diagnosis or substitute for clinical judgment. Missing or invalid analysis data must remain an explicit error/unknown state, never a success-shaped “healthy” default.
