# Gemini server endpoint contract

The mobile/web client does not contain Gemini API keys directly. `GEMINI_API_KEYS` is used for authentication or endpoint configuration.

The endpoint is not deployed or configured in this repository yet. Until it is, uploads are stored in Drive and users can digitize each document manually; AI chat and summaries show an explicit configuration error.

## Secrets and authorization

- Configure `GEMINI_API_KEYS` as a JSON array in the server-side secret store, for example `["key-1","key-2"]`. The values must never be logged or returned to the client.
- Verify the Firebase ID token in the `Authorization: Bearer <token>` header before processing a request. Apply per-user rate limits and request-size limits.
- Use a key from the configured pool server-side. Retry another key only for retryable quota or transient errors; do not retry authentication, validation, or safety errors.
- Do not log request bodies, document contents, profile data, access tokens, or API keys. Set retention and deletion behavior for any temporary copies before enabling health data processing.
- Configure CORS for the actual app origins. The endpoint must reject requests without a valid authenticated user.

## Request

The client sends JSON with `Content-Type: application/json` and a Firebase ID token:

```json
{
  "action": "extract",
  "member": { "id": "member-id", "name": "Member name" },
  "document": {
    "name": "report.pdf",
    "mimeType": "application/pdf",
    "dataUrl": "data:application/pdf;base64,..."
  }
}
```

`action` is one of:

- `extract`: receives `member` and `document`; return `{ "event": { ... } }`.
- `chat`: receives `member`, `question`, and that member's `profile`; return `{ "answer": "..." }`.
- `summarize`: receives `member` and that member's `profile`; return `{ "narrative": "..." }`.

An extracted event may include `date`, `type`, `title`, `facility`, `diagnoses`, `medications`, `metrics`, `advice`, `notes`, and arbitrary structured `extractedData`. Preserve uncertain/missing values as empty or unknown; never invent clinical facts. The client presents extracted content for user confirmation before recording it in the append-only timeline.

Return JSON with an appropriate non-2xx status and an `{ "error": "..." }` body on failure. The app does not consider extraction a completed digitization until the user confirms the event and the updated profile has been saved to Drive.
