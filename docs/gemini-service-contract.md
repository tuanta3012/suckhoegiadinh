# Gemini server contract

The client sends requests to the `/api/gemini/*` endpoints. The server verifies the Firebase ID token before calling Gemini. Requests without a valid Firebase identity are rejected. On the native APK only, Firebase Anonymous Auth supplies this AI-service identity; it does not sign the user into Google Drive or grant Drive access. Web clients still need their existing signed-in account.

Enable the Anonymous sign-in provider in Firebase Authentication for the APK's Firebase project. Without it, local storage remains available but Gemini requests fail with the Firebase authentication error.

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

The Drive-connected client saves the original document to Drive; the offline-first native APK instead saves it in the app's private filesystem. Both send the PDF to the server for OCR when a network connection is available. PDFs are split server-side into batches of up to five pages and processed sequentially. A PDF may contain up to 60 pages. Each batch is routed independently through the same quota scheduler; successful batch results are merged in page order with page-specific notes and de-duplicated diagnoses, medications, and metrics. The merged result is stored as one timeline event per source file. If OCR identifies a subject, the client matches or creates that member and saves automatically. If no subject name is extracted, the client requires the user to enter a name and create a new member before assigning and saving the extracted data. The original remains marked as unresolved until the save succeeds.

Progress SSE reports completed page ranges and quota/model activity. A heartbeat is sent while Gemini is working. If a batch ultimately fails, the overall extraction fails explicitly and the original Drive file remains available for retry/manual entry. Multiple selected files are processed sequentially; the queue pauses for required new-member creation when OCR cannot identify a name. The user can defer that file, allowing the rest of the queue to continue; the original can be retried from the OCR recovery prompt or the raw-files manager.

The server's in-flight work and quota counters are process-local, not durable or shared across replicas. On web, the client stores only OCR recovery metadata (Drive file ID, progress, and status) in localStorage; it does not persist health profiles, document bytes, extracted medical data, access tokens, or Gemini keys there. The native APK retains local workspace/profile metadata and original document bytes in app-private storage, even without a Google Drive account. Gemini calls still require a network connection. Local-only data is never uploaded or merged automatically; after connecting Drive and opening a destination workspace, the user can explicitly confirm a one-way copy. The local copy is retained on the device. Browser-selected files still waiting in the upload queue are not persisted. Durable server jobs and shared quota accounting require a backend job/quota store, which is not configured in this deployment.

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
