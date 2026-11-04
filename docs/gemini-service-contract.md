# Gemini server contract

The web/mobile client sends requests to the same-origin `/api/gemini/*` endpoints. The server verifies the Firebase ID token before calling Gemini. Requests without a valid signed-in user are rejected.

## Independent project configuration

Configure each independent Google Cloud project as an entry in the server-only `GEMINI_PROJECTS` JSON environment variable:

```json
[
  { "id": "project-1", "apiKey": "server-secret-key-1" },
  { "id": "project-2", "apiKey": "server-secret-key-2" }
]
```

Use a unique, stable `id` for each project. Do not put Gemini keys in `VITE_*` variables, client storage, request bodies, logs, or responses. A comma/newline-separated `GEMINI_API_KEYS` value remains supported for migration, but it cannot prove that keys belong to independent projects.

## Quota-aware scheduling

The scheduler tracks quota separately for each project and model, rotates across projects for the same model first, and advances to the next model only after the current model has no available project or fails. HTTP 429 responses cool down the affected project-model; daily-quota responses disable it until the next UTC day. Invalid requests and other provider failures are reported rather than silently treated as success.

Configured per-project limits and in-process concurrency:

| Task | Model order | RPM / RPD per project and model | Max active calls |
|---|---|---:|---:|
| Digitization/OCR | `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` | 15 / 500 | 3 |
| Analysis/assistant | `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3-flash` | 5 / 20 | 2 |

These are configured scheduler ceilings based on the supplied quotas, not a guarantee from Google that every project has those limits. Provider 429 responses remain authoritative. The daily ledger and concurrency controls currently live in one server process and reset on process restart; they are not shared across multiple replicas. Do not horizontally scale this server until the scheduler is backed by a shared quota store/lease (for example Redis or a transactional database) and daily usage persistence.

The server also limits each Firebase user to 20 API requests per minute. Document uploads are limited to 25 MB; JSON parsing allows 36 MB for base64 expansion. Analysis calls have a bounded total wait, per-attempt timeout, and SSE heartbeats for the streaming assistant.

## OCR and multi-page PDFs

The client saves the original document to Drive and sends the PDF to the server. PDFs are split server-side into batches of up to three pages, with at most three OCR batches running concurrently per request. A PDF may contain up to 60 pages. Each batch is routed independently through the same quota scheduler; successful batch results are merged in page order with page-specific notes and de-duplicated diagnoses, medications, and metrics. The merged result remains one reviewable timeline event per source file.

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
