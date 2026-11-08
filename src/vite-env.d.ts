/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_MODE?: string;
  readonly VITE_APP_VERSION?: string;
  readonly VITE_GOOGLE_PICKER_API_KEY?: string;
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
