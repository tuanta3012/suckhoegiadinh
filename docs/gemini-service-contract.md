# Gemini service contract

## Web and native request paths

Web builds use same-origin `/api/gemini/*` requests. The Express server verifies the Firebase ID token before calling Gemini; requests without a valid Firebase identity are rejected. Configure the server-only `GEMINI_API_KEYS` environment variable (or legacy `GEMINI_API_KEY`) for the web backend.

The native APK calls Google Gemini directly. Its API keys are managed from **Settings → Tài nguyên AI** and stored in `ai-resources.json` in the shared Google Drive workspace folder. The app tests every entered key against `gemini-3.5-flash-lite` before saving. OCR, assistant, summary, refinement, and analysis use the shared keys; the APK build no longer requires `VITE_BACKEND_URL`.

## Important key-sharing warning

`ai-resources.json` contains the keys as readable plain text. Anyone who can read the shared Drive folder can retrieve and use those keys outside the app; hiding the values in the viewer UI does not make them secret. Set API restrictions and quota/billing limits in Google AI Studio/Google Cloud, monitor usage, and rotate or revoke a key if a member leaves. Do not reuse these keys for other services.

Only the workspace admin is offered editing controls in the app. This is a user-interface restriction, not a server-enforced security boundary: Drive permissions and client-side code cannot prevent a folder reader from obtaining the file contents.

The old `stk_gemini_api_keys_pool` entry is still cleared from secure storage, Preferences, and localStorage on startup.

## Quota-aware scheduling

The web backend scheduler tracks quota per key and model. The native app tries the shared keys in order and reports a failure if none succeeds; native requests do not share the server scheduler's quota ledger. OCR uses `gemini-3.5-flash-lite`; analysis uses `gemini-3.6-flash`; assistant, summary, and refinement use `gemini-3.5-flash-lite`.

The following configured limits apply only to the web backend scheduler:

| Task | Model order | RPM / RPD per project and model | Max active calls |
|---|---|---:|---:|
| Digitization/OCR | `gemini-3.5-flash-lite` | 15 / 500 per model | 3 per key and model; batches are sequential per request |
| Analysis | `gemini-3.6-flash` | 5 / 20 | 2 per key and model |
| Assistant/refinement | `gemini-3.5-flash-lite` | 15 / 500 per model | 3 per key and model |

These are configured scheduler ceilings based on the supplied quotas, not a guarantee from Google that every project has those limits. Provider 429 responses remain authoritative. The daily ledger and concurrency controls currently live in one server process and reset on process restart; they are not shared across multiple replicas. Do not horizontally scale this server until the scheduler is backed by a shared quota store/lease (for example Redis or a transactional database) and daily usage persistence.

The server also limits each Firebase user to 20 API requests per minute. Document uploads are limited to 25 MB; JSON parsing allows 36 MB for base64 expansion. OCR requests have a 10-minute total timeout and up to five minutes per provider attempt. Analysis requests have a five-minute total timeout and up to three minutes per provider attempt.

## OCR and multi-page PDFs

The Drive-connected client saves the original document to Drive; the offline-first native APK instead saves it in the app's private filesystem. Web requests send PDFs to the backend for OCR. The APK splits PDFs locally into sequential batches of up to five pages and calls Gemini directly. A PDF may contain up to 60 pages. Batch results are merged in page order with de-duplicated diagnoses, medications, and metrics. The merged result is stored as one timeline event per source file. If OCR identifies a subject, the client matches or creates that member and saves automatically. If no subject name is extracted, the client requires the user to enter a name and create a new member before assigning and saving the extracted data. The original remains marked as unresolved until the save succeeds.

Web progress SSE reports completed page ranges and quota/model activity. Native progress is updated after each batch completes. If a batch fails, extraction fails explicitly and the original remains available for retry/manual entry. Multiple selected files are processed sequentially; the queue pauses for required new-member creation when OCR cannot identify a name. The user can defer that file, allowing the rest of the queue to continue; the original can be retried from the OCR recovery prompt or raw-files manager.

The server's in-flight work and quota counters are process-local, not durable or shared across replicas. On web, the client stores only OCR recovery metadata in localStorage and sends AI requests to the backend. The native APK retains local workspace/profile metadata and original document bytes in app-private storage, even without a Google Drive account. Gemini calls require a network connection and a linked shared workspace containing `ai-resources.json`. Local-only data is never uploaded or merged automatically; after connecting Drive and opening a destination workspace, the user can explicitly confirm a one-way copy. The local copy is retained on the device. Browser-selected files still waiting in the upload queue are not persisted.

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
