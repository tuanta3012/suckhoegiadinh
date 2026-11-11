# Gemini service contract

## Web and native request paths

Both the web app and native APK call the Google Gemini API directly from the client. OCR, assistant, summary, refinement, comprehensive analysis, and API-key validation use the keys configured in **Tài nguyên AI**. These AI flows do not call the Express `/api/gemini/*` endpoints and do not require `VITE_BACKEND_URL`.

The app loads shared keys from `ai-resources.json` in the connected Google Drive workspace and can retain them locally for subsequent use. Configured keys are tried in order; provider errors are reported if none succeeds. Web uses `fetch`; native builds use Capacitor HTTP. A network connection and at least one configured key are required.

## Key-sharing and privacy warning

`ai-resources.json` contains API keys as readable plain text. Anyone who can read the shared Drive folder may retrieve and use them outside the app. Hiding key values in the UI is not a security boundary. Restrict keys in Google AI Studio/Google Cloud, set quota and billing limits, monitor usage, and rotate or revoke keys when access should end. Do not reuse these keys for other services.

Only the workspace admin is offered key-editing controls in the app. This is a UI restriction, not server-enforced authorization: a folder reader can obtain the file contents.

The old `stk_gemini_api_keys_pool` entry is cleared from secure storage, Preferences, and localStorage on startup.

## Models and quota behavior

| Task | Model |
|---|---|
| OCR/digitization | `gemini-3.5-flash-lite` |
| Assistant, summary, refinement | `gemini-3.5-flash-lite` |
| Comprehensive analysis | `gemini-3.6-flash` |

Requests use the configured Google AI Studio project quotas. There is no client-shared quota ledger or cross-device scheduler; Google provider errors such as 429 remain authoritative.

## OCR and multi-page PDFs

The client saves the original document to the connected workspace (or to app-private storage in offline-first native mode), then calls Gemini directly. PDFs are split locally into sequential batches of up to five pages; a PDF may contain up to 60 pages. Batch results are merged in page order with de-duplicated diagnoses, medications, and metrics. The merged result is stored as one timeline event per source file.

If OCR identifies a subject, the client performs the configured member-matching flow before saving. If the subject name is missing or does not match, the user can manually select an existing member or create a new member. The original remains unresolved until saving succeeds. A batch failure is surfaced explicitly and the original remains available for retry/manual entry.

Native builds retain local workspace/profile metadata and original document bytes in app-private storage. Local-only data is not uploaded or merged automatically; after connecting Drive, the user can explicitly confirm a one-way copy. Browser-selected files still waiting in the upload queue are not persisted.

OCR and analysis output is model-generated and may be inaccurate; it is not a diagnosis or substitute for clinical judgment. Missing or invalid analysis data must remain an explicit error/unknown state, never a success-shaped “healthy” default.
