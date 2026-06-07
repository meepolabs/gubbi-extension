/// <reference types="vite/client" />

// Public, build-time configuration. All values are non-secret client config
// injected by Vite from VITE_* environment variables (see .env.example).
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_HOST?: string;
  readonly VITE_HYDRA_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
