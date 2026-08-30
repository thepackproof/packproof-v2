/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PACKPROOF_API_BASE_URL?: string;
  readonly VITE_PACKPROOF_AUTH_MODE?: string;
  readonly VITE_PACKPROOF_COGNITO_USER_POOL_ID?: string;
  readonly VITE_PACKPROOF_COGNITO_CLIENT_ID?: string;
  readonly VITE_PACKPROOF_COGNITO_REGION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
