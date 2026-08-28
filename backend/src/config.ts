import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  port: number;
  publicBaseUrl: string;
  databaseUrl?: string;
  pgliteDir: string;
  objectStore: "local" | "s3";
  awsRegion?: string;
  awsS3Bucket?: string;
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
  const objectStore = env.OBJECT_STORE === "s3" ? "s3" : "local";
  return {
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: env.PACKPROOF_PUBLIC_URL ?? "http://127.0.0.1:3000",
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: path.resolve(env.PGLITE_DIR ?? path.join(process.cwd(), "data")),
    objectStore,
    awsRegion: env.AWS_REGION,
    awsS3Bucket: env.AWS_S3_BUCKET,
    devAuth: env.PACKPROOF_DEV_AUTH === "true",
    uploadSecret: env.PACKPROOF_UPLOAD_SECRET ?? "dev-upload-secret",
  };
}
