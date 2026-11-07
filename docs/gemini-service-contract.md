# Gemini server contract

The web/mobile client sends requests to the same-origin `/api/gemini/*` endpoints. The server verifies the Firebase ID token before calling Gemini. Requests without a valid signed-in user are rejected.

## Independent project configuration

Configure Google API keys in the server-only `GEMINI_API_KEYS` environment variable. The legacy `GEMINI_API_KEY` variable is also accepted as a single-key fallback. Use keys from distinct Google projects when sharing quota:

```env
GEMINI_API_KEYS=key-from-project-1,key-from-project-2
```

Do not put Gemini keys in `VITE_*` variables, client storage, request bodies, logs, or responses.

The unused client-side Gemini key pool has been removed. On startup, the app also clears its legacy `stk_gemini_api_keys_pool` entry from secure storage, Preferences, and localStorage.

## Quota-aware scheduling

The scheduler tracks quota separately for each key and model and rotates across configured keys. OCR uses `gemini-3.5-flash-lite`; analysis uses `gemini-3.6-flash`; assistant and refinement currently use `gemini-3.5-flash-lite`. There is no configured model fallback. If a key fails, the server tries another configured key for that task. Provider 429 responses cool down the affected key-model, and daily-quota responses exhaust that key-model until the next UTC day. Invalid requests and other provider failures are reported rather than silently treated as success.

Configured per-project limits and in-process concurrency:

| Task | Model order | RPM / RPD per project and model | Max active calls |
|---|---|---:|---:|
| Digitization/OCR | `gemini-3.5-flash-lite` | 15 / 500 per model | 3 per key and model; batches are sequential per request |
| Analysis | `gemini-3.6-flash` | 5 / 20 | 2 per key and model |
| Assistant/refinement | `gemini-3.5-flash-lite` | 15 / 500 per model | 3 per key and model |

These are configured scheduler ceilings based on the supplied quotas, not a guarantee from Google that every project has those limits. Provider 429 responses remain authoritative. The daily ledger and concurrency controls currently live in one server process and reset on process restart; they are not shared across multiple replicas. Do not horizontally scale this server until the scheduler is backed by a shared quota store/lease (for example Redis or a transactional database) and daily usage persistence.

The server also limits each Firebase user to 20 API requests per minute. Document uploads are limited to 25 MB; JSON parsing allows 36 MB for base64 expansion. OCR requests have a 10-minute total timeout and up to five minutes per provider attempt. Analysis requests have a five-minute total timeout and up to three minutes per provider attempt.

## OCR and multi-page PDFs

The client saves the original document to Drive and sends the PDF to the server. PDFs are split server-side into batches of up to five pages and processed sequentially. A PDF may contain up to 60 pages. Each batch is routed independently through the same quota scheduler; successful batch results are merged in page order with page-specific notes and de-duplicated diagnoses, medications, and metrics. The merged result is stored as one timeline event per source file. If OCR identifies a subject, the client matches or creates that member and saves automatically. If no subject name is extracted, the client asks the user to select an existing member or enter a name for a new member before saving.

Progress SSE reports completed page ranges and quota/model activity. A heartbeat is sent while Gemini is working. If a batch ultimately fails, the overall extraction fails explicitly and the original Drive file remains available for retry/manual entry. Multiple selected files are processed sequentially; the queue pauses for subject assignment when OCR cannot identify a name.

The server's in-flight work and quota counters are process-local, not durable or shared across replicas. On web, the client stores only OCR recovery metadata (Drive file ID, progress, and status) in localStorage; it does not persist health profiles, document bytes, extracted medical data, access tokens, or Gemini keys there. The native app retains an account-scoped offline workspace/profile cache. After a reload, the web UI offers to download the original from Drive and rerun OCR; it cannot attach to or continue the original server request. Browser-selected files still waiting in the upload queue are not persisted. Durable server jobs and shared quota accounting require a backend job/quota store, which is not configured in this deployment.

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

OCR and analysis output are model-generated and may be inaccurate; they are not a diagnosis or substitute for clinical judgment. Missing or invalid analysis data must remain an explicit error/unknown state, never a success-shaped “healthy” default.
