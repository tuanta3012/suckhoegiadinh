# Gemini service contract

## Web and native request paths

The assistant, summary, refinement, comprehensive analysis, OCR, and API-key validation use the Express `/api/gemini/*` gateway. Web builds use same-origin requests when served by the backend, or `VITE_BACKEND_URL` when the frontend and API are deployed separately. Android APK/AAB builds require `VITE_BACKEND_URL` to be set to the HTTPS origin of the deployed backend; release builds read it from the GitHub Actions secret with the same name.

The app loads the active workspace's keys from `ai-resources.json` in Google Drive (or the local cache for a local workspace) and sends them with each Gemini request. The backend uses only those request keys; it does not fall back to `GEMINI_API_KEYS` or `GEMINI_API_KEY` environment variables. Task-specific prompts and response handling remain separate, while key validation, project selection, quota scheduling, and provider failover share the same backend implementation. OCR reuses one request context across all PDF batches. A network connection, a reachable backend, and at least one key in **Tài nguyên AI** are required.

## Key-sharing and privacy warning

`ai-resources.json` contains API keys as readable plain text. Anyone who can read the shared Drive folder may retrieve and use them outside the app. The app also sends the selected keys to the backend over HTTPS for each Gemini request; the backend uses them in memory and must not log or persist request keys. Hiding key values in the UI is not a security boundary. Restrict keys in Google AI Studio/Google Cloud, set quota and billing limits, monitor usage, and rotate or revoke keys when access should end. Do not reuse these keys for other services.

Only the workspace admin is offered key-editing controls in the app. This is a UI restriction, not server-enforced authorization: a folder reader can obtain the file contents.

The old `stk_gemini_api_keys_pool` entry is cleared from secure storage, Preferences, and localStorage on startup.

## Models and quota behavior

| Task | Model |
|---|---|
| OCR/digitization | `gemini-3.5-flash-lite` |
| Assistant, summary, refinement | `gemini-3.5-flash-lite` |
| Comprehensive analysis | `gemini-3.6-flash` |

Each request gets a quota scheduler built from its workspace keys; OCR shares that scheduler across its sequential PDF batches. The scheduler is in-memory and request-scoped, not a cross-request or cross-device quota ledger; Google provider errors such as 429 remain authoritative.

## Health assistant context and medical sources

The health assistant sends the current question, the selected member's recent health summary, and at most the latest ten chat messages to Gemini. Conversation history stays in the current app session and is cleared when the selected member, workspace, or signed-in account changes; it is not persisted as chat history.

External research is a separate Google Search grounding request. It receives only a sanitized version of the current question, not the member profile or prior conversation. The final answer request receives the chat context and, when available, a short research summary. Research is used only when every returned web citation is HTTPS and belongs to an approved medical domain (WHO, Vietnam's Ministry of Health, CDC, NHS, MedlinePlus/PubMed/NCBI, FDA, EMA, NCI, Mayo Clinic, Cleveland Clinic, or American Heart Association). If sources do not pass validation, they are omitted and the assistant must not claim external verification.

The assistant is limited to health topics, must not make definitive diagnoses or prescribe/change individual medication, and should direct urgent cases to emergency services (115 in Vietnam). AI guidance and the cited material are informational and do not replace care from a clinician.

## OCR and multi-page PDFs

The client saves the original document to the connected workspace (or to app-private storage in offline-first native mode), then sends OCR requests through the shared backend gateway. PDFs are split locally into sequential batches of up to five pages; a PDF may contain up to 60 pages. Batch results are merged in page order with de-duplicated diagnoses, medications, metrics, and page-level text indexes. The merged result is stored as one timeline event per source file.

If OCR identifies a subject, the client performs the configured member-matching flow before saving. If the subject name is missing or does not match, the user can manually select an existing member or create a new member. The original remains unresolved until saving succeeds. A batch failure is surfaced explicitly and the original remains available for retry/manual entry.

Native builds retain local workspace/profile metadata and original document bytes in app-private storage. Local-only data is not uploaded or merged automatically; after connecting Drive, the user can explicitly confirm a one-way copy. Browser-selected files still waiting in the upload queue are not persisted.

OCR and analysis output is model-generated and may be inaccurate; it is not a diagnosis or substitute for clinical judgment. Missing or invalid analysis data must remain an explicit error/unknown state, never a success-shaped “healthy” default.

## Raw-document deduplication and retention

The app treats matching SHA-256 fingerprints of the processed upload bytes as exact duplicates; a matching filename or file size alone is never sufficient. For later uploads, it may compare complete page-level OCR text indexes when both sources are processed, linked to timeline data, within the 120,000-character index limit, and tied to the same recognized member. Containment requires at least 98% document shingle coverage and 94% coverage on every page; incomplete, short, ambiguous, or partially overlapping documents are retained.

When an incoming document is confidently contained by an existing source, its OCR-derived event data and provenance are merged into the health-profile JSON before the incoming raw is skipped. When the incoming document contains an existing source, the more complete incoming raw is retained and old subset raws are eligible for cleanup only after profile persistence succeeds. Exact duplicate cleanup follows the same persistence gate. Cleanup moves redundant Drive files to the recoverable Trash, records source contributions and `rawDeletedAt`, and attempts restoration if saving the post-trash metadata fails. A pending/offline profile save prevents cleanup. No raw file is permanently deleted by this workflow.

Page indexes are generated from Gemini's returned page transcription and stored in profile JSON; they are not independently verified OCR. They contain sensitive document text, so shared-folder access also exposes that text to folder readers. Index size limits and conservative matching intentionally prefer retaining an uncertain raw over discarding source material.
