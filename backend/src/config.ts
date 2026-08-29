import fs from "node:fs";
import path from "node:path";

export type AuthMode = "dev" | "cognito";

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: env.PACKPROOF_PUBLIC_URL ?? "http://127.0.0.1:3000",
    databaseUrl: env.DATABASE_URL || undefined,
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
  };
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
