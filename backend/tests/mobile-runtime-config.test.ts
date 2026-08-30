import { describe, expect, it } from "vitest";
import {
  DEV_DEFAULT_API_BASE_URL,
  STAGING_API_BASE_URL,
  STAGING_COGNITO,
  isPrivateOrLocalDevelopmentHost,
  isReleaseSafeApiUrl,
  resolveRuntimeConfig,
  shouldRestoreCachedSession,
} from "../../mobile/src/runtime-config.ts";

const STAGING_ENV = {
  EXPO_PUBLIC_PACKPROOF_API_BASE_URL: STAGING_API_BASE_URL,
  EXPO_PUBLIC_PACKPROOF_AUTH_MODE: "cognito" as const,
  EXPO_PUBLIC_COGNITO_USER_POOL_ID: STAGING_COGNITO.userPoolId,
  EXPO_PUBLIC_COGNITO_CLIENT_ID: STAGING_COGNITO.clientId,
  EXPO_PUBLIC_COGNITO_REGION: STAGING_COGNITO.region,
};

describe("mobile runtime config", () => {
  it("classifies localhost and private LAN hosts as development-only", () => {
    expect(isPrivateOrLocalDevelopmentHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalDevelopmentHost("localhost")).toBe(true);
    expect(isPrivateOrLocalDevelopmentHost("10.0.2.2")).toBe(true);
    expect(isPrivateOrLocalDevelopmentHost("192.168.1.10")).toBe(true);
    expect(isPrivateOrLocalDevelopmentHost("10.0.0.5")).toBe(true);
    expect(isPrivateOrLocalDevelopmentHost("172.16.4.2")).toBe(true);
    expect(isPrivateOrLocalDevelopmentHost("pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws")).toBe(
      false,
    );
  });

  it("rejects localhost and http URLs as release-safe API targets", () => {
    expect(isReleaseSafeApiUrl("http://127.0.0.1:3000")).toBe(false);
    expect(isReleaseSafeApiUrl("http://localhost:3000")).toBe(false);
    expect(isReleaseSafeApiUrl(STAGING_API_BASE_URL)).toBe(true);
  });

  it("lets a development build keep an intentional localhost override", () => {
    const resolved = resolveRuntimeConfig({
      env: STAGING_ENV,
      isRelease: false,
      cached: {
        apiBaseUrl: "http://127.0.0.1:3000",
        authMode: "dev",
      },
    });
    expect(resolved.apiBaseUrl).toBe("http://127.0.0.1:3000");
    expect(resolved.authMode).toBe("dev");
    expect(resolved.allowsApiOverride).toBe(true);
    expect(resolved.allowsDevAuth).toBe(true);
  });

  it("ignores a stale localhost override in a release build", () => {
    const resolved = resolveRuntimeConfig({
      env: STAGING_ENV,
      isRelease: true,
      cached: {
        apiBaseUrl: "http://127.0.0.1:3000",
        authMode: "dev",
        cognitoUserPoolId: "us-east-1_stale",
        cognitoClientId: "stale-client",
      },
    });
    expect(resolved.apiBaseUrl).toBe(STAGING_API_BASE_URL);
    expect(resolved.authMode).toBe("cognito");
    expect(resolved.cognito).toEqual(STAGING_COGNITO);
    expect(resolved.allowsApiOverride).toBe(false);
    expect(resolved.allowsDevAuth).toBe(false);
  });

  it("falls back to staging when a release build is missing or given a local API env", () => {
    const missing = resolveRuntimeConfig({
      env: { EXPO_PUBLIC_PACKPROOF_AUTH_MODE: "dev" },
      isRelease: true,
    });
    expect(missing.apiBaseUrl).toBe(STAGING_API_BASE_URL);
    expect(missing.authMode).toBe("cognito");
    expect(missing.cognito).toEqual(STAGING_COGNITO);

    const localEnv = resolveRuntimeConfig({
      env: {
        EXPO_PUBLIC_PACKPROOF_API_BASE_URL: "http://127.0.0.1:3000",
        EXPO_PUBLIC_PACKPROOF_AUTH_MODE: "dev",
      },
      isRelease: true,
    });
    expect(localEnv.apiBaseUrl).toBe(STAGING_API_BASE_URL);
    expect(localEnv.authMode).toBe("cognito");
  });

  it("defaults an unset development API to localhost without forcing Cognito", () => {
    const resolved = resolveRuntimeConfig({ env: {}, isRelease: false });
    expect(resolved.apiBaseUrl).toBe(DEV_DEFAULT_API_BASE_URL);
    expect(resolved.authMode).toBe("dev");
    expect(resolved.allowsApiOverride).toBe(true);
  });

  it("restores Cognito sessions in release builds and refuses leftover dev auth", () => {
    expect(
      shouldRestoreCachedSession({ authMode: "cognito", token: "tok" }, true),
    ).toBe(true);
    expect(shouldRestoreCachedSession({ authMode: "dev", token: "tok" }, true)).toBe(false);
    expect(shouldRestoreCachedSession({ authMode: "dev", token: "tok" }, false)).toBe(true);
  });
});
