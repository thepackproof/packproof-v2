import fs from "node:fs";
import path from "node:path";

import type { EbayEnvironment } from "./integrations/ebay/constants.js";

export type AuthMode = "dev" | "cognito";

export interface ReleaseIdentity {
  service: string;
  environment: string;
  commit: string | null;
  version: string | null;
  image: string | null;
}

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  databaseUrl?: string;
  pgliteDir: string;
  objectStore: "local" | "s3";
  awsRegion?: string;
  awsS3Bucket?: string;
  s3UploadExpiresSeconds: number;
  authMode: AuthMode;
  cognitoUserPoolId?: string;
  cognitoClientId?: string;
  cognitoRegion?: string;
  devAuth: boolean;
  uploadSecret: string;
  webOrigins: string[];
  credentialStore: "memory" | "env" | "secrets-manager";
  release: ReleaseIdentity;
  ebay: EbayConfig;
  shopify: ShopifyOAuthConfig;
  google: GoogleOAuthConfig;
  facebook: FacebookOAuthConfig;
}

export interface EbayConfig {
  enabled: boolean;
  environment: EbayEnvironment;
  clientId: string | null;
  ruName: string | null;
  marketplaceId: string;
  appCredentialReference: string | null;
  deletionVerificationToken: string | null;
}

export interface ShopifyOAuthConfig {
  enabled: boolean;
  clientId: string | null;
  appCredentialReference: string | null;
}

export interface GoogleOAuthConfig {
  enabled: boolean;
  clientId: string | null;
  appCredentialReference: string | null;
}

export interface FacebookOAuthConfig {
  enabled: boolean;
  appId: string | null;
  appCredentialReference: string | null;
}

export function loadEnvFile(cwd = process.cwd()): void {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function composeDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const host = env.PACKPROOF_DB_HOST?.trim();
  const user = env.PACKPROOF_DB_USER?.trim();
  const password = env.PACKPROOF_DB_PASSWORD;
  const name = env.PACKPROOF_DB_NAME?.trim();
  const port = (env.PACKPROOF_DB_PORT ?? "5432").trim();
  if (!host || !user || password == null || password === "" || !name) {
    return undefined;
  }
  const sslmode = (env.PACKPROOF_DB_SSLMODE ?? "require").trim() || "require";
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(name)}?sslmode=${encodeURIComponent(sslmode)}`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: env.PACKPROOF_PUBLIC_URL ?? "http://127.0.0.1:3000",
    databaseUrl: env.DATABASE_URL || composeDatabaseUrl(env) || undefined,
    pgliteDir: path.resolve(env.PGLITE_DIR ?? path.join(process.cwd(), "data")),
    objectStore: parseObjectStoreMode(env),
    awsRegion: env.AWS_REGION,
    awsS3Bucket: env.PACKPROOF_S3_BUCKET || env.AWS_S3_BUCKET || undefined,
    s3UploadExpiresSeconds: parseS3UploadExpiresSeconds(env),
    authMode: parseAuthMode(env),
    cognitoUserPoolId: env.PACKPROOF_COGNITO_USER_POOL_ID || undefined,
    cognitoClientId: env.PACKPROOF_COGNITO_CLIENT_ID || undefined,
    cognitoRegion: env.PACKPROOF_COGNITO_REGION || env.AWS_REGION || undefined,
    devAuth: env.PACKPROOF_DEV_AUTH === "true",
    uploadSecret: env.PACKPROOF_UPLOAD_SECRET ?? "dev-upload-secret",
    webOrigins: parseWebOrigins(env),
    credentialStore: parseCredentialStoreMode(env),
    release: parseReleaseIdentity(env),
    ebay: parseEbayConfig(env),
    shopify: parseShopifyConfig(env),
    google: parseGoogleConfig(env),
    facebook: parseFacebookConfig(env),
  };
}

export function parseEbayConfig(env: NodeJS.ProcessEnv = process.env): EbayConfig {
  const environment = parseEbayEnvironment(env);
  const clientId =
    env.PACKPROOF_EBAY_CLIENT_ID?.trim() || env.EBAY_CLIENT_ID?.trim() || null;
  const ruName = env.PACKPROOF_EBAY_RUNAME?.trim() || env.EBAY_RUNAME?.trim() || null;
  const marketplaceId =
    env.PACKPROOF_EBAY_MARKETPLACE_ID?.trim() || env.EBAY_MARKETPLACE_ID?.trim() || "EBAY_US";
  const explicitReference = env.PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE?.trim() || null;
  const secretName = env.PACKPROOF_EBAY_CLIENT_SECRET
    ? "PACKPROOF_EBAY_CLIENT_SECRET"
    : env.EBAY_CLIENT_SECRET
      ? "EBAY_CLIENT_SECRET"
      : null;
  const enabled = parseBooleanFlag(env.PACKPROOF_EBAY_INTEGRATION_ENABLED ?? env.EBAY_INTEGRATION_ENABLED);
  const appCredentialReference = explicitReference ?? (secretName ? `env:${secretName}` : null);
  if (enabled) {
    assertEbayEnabledConfiguration({ environment, clientId, ruName, appCredentialReference });
  }
  return {
    enabled,
    environment,
    clientId,
    ruName,
    marketplaceId,
    appCredentialReference,
    deletionVerificationToken:
      env.PACKPROOF_EBAY_DELETION_VERIFICATION_TOKEN?.trim() ||
      env.EBAY_DELETION_VERIFICATION_TOKEN?.trim() ||
      null,
  };
}

function assertEbayEnabledConfiguration(input: {
  environment: EbayEnvironment;
  clientId: string | null;
  ruName: string | null;
  appCredentialReference: string | null;
}): void {
  const missing: string[] = [];
  if (!input.clientId) {
    missing.push("PACKPROOF_EBAY_CLIENT_ID");
  }
  if (!input.ruName) {
    missing.push("PACKPROOF_EBAY_RUNAME");
  }
  if (!input.appCredentialReference) {
    missing.push("PACKPROOF_EBAY_CLIENT_SECRET or PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE");
  }
  if (missing.length > 0) {
    throw new Error(
      `PACKPROOF_EBAY_INTEGRATION_ENABLED requires ${missing.join(", ")}. Secret values are not included in this message.`,
    );
  }
  const appId = (input.clientId ?? "").toUpperCase();
  const sandboxKeyset = appId.includes("-SBX-") || appId.includes("_SBX_");
  const productionKeyset = appId.includes("-PRD-") || appId.includes("_PRD_");
  if (input.environment === "production" && sandboxKeyset) {
    throw new Error("PACKPROOF_EBAY_ENVIRONMENT=production cannot be used with a Sandbox App ID.");
  }
  if (input.environment === "sandbox" && productionKeyset) {
    throw new Error("PACKPROOF_EBAY_ENVIRONMENT=sandbox cannot be used with a Production App ID.");
  }
}

export function parseEbayEnvironment(env: NodeJS.ProcessEnv = process.env): EbayEnvironment {
  const raw = (env.PACKPROOF_EBAY_ENVIRONMENT ?? env.EBAY_ENVIRONMENT ?? "sandbox").trim().toLowerCase();
  if (raw === "sandbox" || raw === "production") {
    return raw;
  }
  throw new Error(
    `PACKPROOF_EBAY_ENVIRONMENT must be "sandbox" or "production" (received ${JSON.stringify(raw)})`,
  );
}

export function parseFacebookConfig(env: NodeJS.ProcessEnv = process.env): FacebookOAuthConfig {
  const enabled = parseBooleanFlag(
    env.PACKPROOF_FACEBOOK_INTEGRATION_ENABLED ?? env.PACKPROOF_META_INTEGRATION_ENABLED,
  );
  const appId =
    env.PACKPROOF_FACEBOOK_APP_ID?.trim() || env.PACKPROOF_META_APP_ID?.trim() || null;
  const secretName = env.PACKPROOF_FACEBOOK_APP_SECRET
    ? "PACKPROOF_FACEBOOK_APP_SECRET"
    : env.PACKPROOF_META_APP_SECRET
      ? "PACKPROOF_META_APP_SECRET"
      : null;
  const appCredentialReference =
    env.PACKPROOF_FACEBOOK_APP_CREDENTIAL_REFERENCE?.trim() ||
    (secretName ? `env:${secretName}` : null);
  if (enabled) {
    const missing: string[] = [];
    if (!appId) {
      missing.push("PACKPROOF_FACEBOOK_APP_ID");
    }
    if (!appCredentialReference) {
      missing.push("PACKPROOF_FACEBOOK_APP_SECRET");
    }
    if (missing.length > 0) {
      throw new Error(
        `PACKPROOF_FACEBOOK_INTEGRATION_ENABLED requires ${missing.join(", ")}. Secret values are not included in this message.`,
      );
    }
  }
  return { enabled, appId, appCredentialReference };
}

export function parseGoogleConfig(env: NodeJS.ProcessEnv = process.env): GoogleOAuthConfig {
  const enabled = parseBooleanFlag(env.PACKPROOF_GOOGLE_INTEGRATION_ENABLED);
  const clientId = env.PACKPROOF_GOOGLE_CLIENT_ID?.trim() || null;
  const secretName = env.PACKPROOF_GOOGLE_CLIENT_SECRET ? "PACKPROOF_GOOGLE_CLIENT_SECRET" : null;
  const appCredentialReference =
    env.PACKPROOF_GOOGLE_APP_CREDENTIAL_REFERENCE?.trim() ||
    (secretName ? `env:${secretName}` : null);
  if (enabled) {
    const missing: string[] = [];
    if (!clientId) {
      missing.push("PACKPROOF_GOOGLE_CLIENT_ID");
    }
    if (!appCredentialReference) {
      missing.push("PACKPROOF_GOOGLE_CLIENT_SECRET");
    }
    if (missing.length > 0) {
      throw new Error(
        `PACKPROOF_GOOGLE_INTEGRATION_ENABLED requires ${missing.join(", ")}. Secret values are not included in this message.`,
      );
    }
  }
  return { enabled, clientId, appCredentialReference };
}

export function parseShopifyConfig(env: NodeJS.ProcessEnv = process.env): ShopifyOAuthConfig {
  const enabled = parseBooleanFlag(env.PACKPROOF_SHOPIFY_INTEGRATION_ENABLED);
  const clientId = env.PACKPROOF_SHOPIFY_CLIENT_ID?.trim() || env.SHOPIFY_CLIENT_ID?.trim() || null;
  const explicitReference = env.PACKPROOF_SHOPIFY_APP_CREDENTIAL_REFERENCE?.trim() || null;
  const secretName = env.PACKPROOF_SHOPIFY_CLIENT_SECRET
    ? "PACKPROOF_SHOPIFY_CLIENT_SECRET"
    : env.SHOPIFY_CLIENT_SECRET
      ? "SHOPIFY_CLIENT_SECRET"
      : null;
  const appCredentialReference = explicitReference ?? (secretName ? `env:${secretName}` : null);
  if (enabled) {
    const missing: string[] = [];
    if (!clientId) {
      missing.push("PACKPROOF_SHOPIFY_CLIENT_ID");
    }
    if (!appCredentialReference) {
      missing.push("PACKPROOF_SHOPIFY_CLIENT_SECRET or PACKPROOF_SHOPIFY_APP_CREDENTIAL_REFERENCE");
    }
    if (missing.length > 0) {
      throw new Error(
        `PACKPROOF_SHOPIFY_INTEGRATION_ENABLED requires ${missing.join(", ")}. Secret values are not included in this message.`,
      );
    }
  }
  return { enabled, clientId, appCredentialReference };
}

function parseBooleanFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true" || value?.trim() === "1";
}

export function parseReleaseIdentity(env: NodeJS.ProcessEnv = process.env): ReleaseIdentity {
  return {
    service: "packproof-api",
    environment: env.PACKPROOF_ENVIRONMENT?.trim() || "development",
    commit: env.PACKPROOF_RELEASE_SHA?.trim() || null,
    version: env.PACKPROOF_RELEASE_VERSION?.trim() || null,
    image: env.PACKPROOF_RELEASE_IMAGE?.trim() || null,
  };
}

export function parseCredentialStoreMode(
  env: NodeJS.ProcessEnv = process.env,
): "memory" | "env" | "secrets-manager" {
  const raw = env.PACKPROOF_CREDENTIAL_STORE ?? "env";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "memory" || normalized === "env" || normalized === "secrets-manager") {
    return normalized;
  }
  throw new Error(
    `PACKPROOF_CREDENTIAL_STORE must be "memory", "env", or "secrets-manager" (received ${JSON.stringify(raw)})`,
  );
}

export function parseWebOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PACKPROOF_WEB_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function parseAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  const raw = env.PACKPROOF_AUTH_MODE ?? "dev";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "dev") {
    return "dev";
  }
  if (normalized === "cognito") {
    return "cognito";
  }
  throw new Error(
    `PACKPROOF_AUTH_MODE must be "dev" or "cognito" (received ${JSON.stringify(raw)})`,
  );
}

export function parseObjectStoreMode(env: NodeJS.ProcessEnv = process.env): "local" | "s3" {
  const raw = env.PACKPROOF_OBJECT_STORAGE ?? env.OBJECT_STORE ?? "local";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "local") {
    return "local";
  }
  if (normalized === "s3") {
    return "s3";
  }
  throw new Error(
    `PACKPROOF_OBJECT_STORAGE must be "local" or "s3" (received ${JSON.stringify(raw)})`,
  );
}

export function parseS3UploadExpiresSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS ?? "3600";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 604800) {
    throw new Error(
      "PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS must be an integer from 1 to 604800",
    );
  }
  return parsed;
}
