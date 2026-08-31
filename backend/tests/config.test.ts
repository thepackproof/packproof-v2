import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeDatabaseUrl, loadConfig } from "../src/config.js";
import { sslConfigFromConnectionString } from "../src/db/postgres.js";

describe("storage configuration", () => {
  it("defaults to local and accepts PACKPROOF_OBJECT_STORAGE", () => {
    expect(loadConfig({}).objectStore).toBe("local");
    expect(loadConfig({ PACKPROOF_OBJECT_STORAGE: "local" }).objectStore).toBe("local");
    expect(
      loadConfig({
        PACKPROOF_OBJECT_STORAGE: "s3",
        PACKPROOF_S3_BUCKET: "packproof-v2-evidence",
        AWS_REGION: "us-east-1",
        PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS: "900",
        PACKPROOF_AUTH_MODE: "cognito",
        PACKPROOF_COGNITO_USER_POOL_ID: "us-east-1_example",
        PACKPROOF_COGNITO_CLIENT_ID: "exampleClientId",
      }),
    ).toMatchObject({
      objectStore: "s3",
      awsS3Bucket: "packproof-v2-evidence",
      awsRegion: "us-east-1",
      s3UploadExpiresSeconds: 900,
      authMode: "cognito",
      cognitoUserPoolId: "us-east-1_example",
      cognitoClientId: "exampleClientId",
      cognitoRegion: "us-east-1",
    });
  });

  it("keeps OBJECT_STORE and AWS_S3_BUCKET as aliases", () => {
    expect(
      loadConfig({
        OBJECT_STORE: "s3",
        AWS_S3_BUCKET: "legacy-bucket",
        AWS_REGION: "us-west-2",
      }),
    ).toMatchObject({
      objectStore: "s3",
      awsS3Bucket: "legacy-bucket",
      awsRegion: "us-west-2",
    });
  });

  it("prefers explicit PACKPROOF_* names over aliases", () => {
    expect(
      loadConfig({
        PACKPROOF_OBJECT_STORAGE: "local",
        OBJECT_STORE: "s3",
        PACKPROOF_S3_BUCKET: "preferred",
        AWS_S3_BUCKET: "alias",
      }),
    ).toMatchObject({
      objectStore: "local",
      awsS3Bucket: "preferred",
    });
  });

  it("composes DATABASE_URL from explicit RDS parts without auto-detecting AWS", () => {
    expect(composeDatabaseUrl({})).toBeUndefined();
    expect(
      composeDatabaseUrl({
        PACKPROOF_DB_HOST: "db.example.internal",
        PACKPROOF_DB_USER: "packproof",
        PACKPROOF_DB_PASSWORD: "p@ss/word",
        PACKPROOF_DB_NAME: "packproof_v2",
      }),
    ).toBe(
      "postgres://packproof:p%40ss%2Fword@db.example.internal:5432/packproof_v2?sslmode=require",
    );
    expect(
      loadConfig({
        PACKPROOF_DB_HOST: "db.example.internal",
        PACKPROOF_DB_USER: "packproof",
        PACKPROOF_DB_PASSWORD: "secret",
        PACKPROOF_DB_NAME: "packproof_v2",
        DATABASE_URL: "postgres://explicit:local@127.0.0.1:5432/packproof_v2",
      }).databaseUrl,
    ).toBe("postgres://explicit:local@127.0.0.1:5432/packproof_v2");
  });

  it("keeps staging adapter names explicit and does not infer Cognito or S3 from NODE_ENV", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      PACKPROOF_AUTH_MODE: "cognito",
      PACKPROOF_OBJECT_STORAGE: "s3",
      PACKPROOF_S3_BUCKET: "packproof-v2-evidence",
      AWS_REGION: "us-east-1",
      PACKPROOF_COGNITO_USER_POOL_ID: "us-east-1_example",
      PACKPROOF_COGNITO_CLIENT_ID: "exampleClientId",
    });
    expect(config.authMode).toBe("cognito");
    expect(config.objectStore).toBe("s3");
    expect(config.devAuth).toBe(false);
    expect(loadConfig({ NODE_ENV: "production" })).toMatchObject({
      authMode: "dev",
      objectStore: "local",
      credentialStore: "env",
    });
  });

  it("exposes only explicit release identity fields", () => {
    expect(loadConfig({}).release).toEqual({
      service: "packproof-api",
      environment: "development",
      commit: null,
      version: null,
      image: null,
    });
    expect(
      loadConfig({
        PACKPROOF_ENVIRONMENT: "staging",
        PACKPROOF_RELEASE_SHA: "6216bc339d9f2bed4c1117660924e32c98682f45",
        PACKPROOF_RELEASE_VERSION: "0.1.0",
        PACKPROOF_RELEASE_IMAGE: "20260831180000",
        PACKPROOF_DB_PASSWORD: "should-not-appear",
      }).release,
    ).toEqual({
      service: "packproof-api",
      environment: "staging",
      commit: "6216bc339d9f2bed4c1117660924e32c98682f45",
      version: "0.1.0",
      image: "20260831180000",
    });
  });

  it("accepts PACKPROOF_CREDENTIAL_STORE without embedding secrets", () => {
    expect(loadConfig({}).credentialStore).toBe("env");
    expect(loadConfig({ PACKPROOF_CREDENTIAL_STORE: "memory" }).credentialStore).toBe("memory");
    expect(loadConfig({ PACKPROOF_CREDENTIAL_STORE: "secrets-manager" }).credentialStore).toBe(
      "secrets-manager",
    );
  });

  it("uses libpq-style sslmode=require without failing RDS certificate chains", () => {
    expect(sslConfigFromConnectionString("postgres://u:p@127.0.0.1:5432/db")).toBeUndefined();
    expect(
      sslConfigFromConnectionString(
        "postgres://u:p@db.example.internal:5432/packproof_v2?sslmode=require",
      ),
    ).toEqual({ rejectUnauthorized: false });
    expect(
      sslConfigFromConnectionString(
        "postgres://u:p@db.example.internal:5432/packproof_v2?sslmode=verify-full",
      ),
    ).toEqual({ rejectUnauthorized: true });
  });

  it("loads PGlite only when PostgreSQL is not configured", async () => {
    const opener = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/db/open.ts"),
      "utf8",
    );
    expect(opener).not.toMatch(/import \{ createPgliteDatabase \}/);
    expect(opener).toMatch(/await import\("\.\/pglite\.js"\)/);
  });

  it("rejects hidden or invalid storage modes", () => {
    expect(() => loadConfig({ PACKPROOF_OBJECT_STORAGE: "auto" })).toThrow(
      /must be "local" or "s3"/,
    );
    expect(() => loadConfig({ PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS: "0" })).toThrow(
      /PACKPROOF_S3_UPLOAD_EXPIRES_SECONDS/,
    );
  });
});
