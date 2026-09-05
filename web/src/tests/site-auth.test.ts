import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApiBaseUrl } from "../auth/session";
import { joinUrl, resolveUploadUrl } from "../api/client";
import { cognitoForgotPassword, cognitoConfirmForgotPassword } from "../auth/cognito";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("hosted website account access", () => {
  it("resolves same-origin API paths for authenticated calls and upload helpers", () => {
    vi.stubEnv("VITE_PACKPROOF_API_BASE_URL", "/api");
    const base = defaultApiBaseUrl();
    expect(joinUrl(base, "/me")).toBe(`${window.location.origin}/api/me`);
    expect(resolveUploadUrl(base, "/upload/signed-token")).toBe(`${window.location.origin}/api/upload/signed-token`);
  });

  it("requests and confirms a password reset with normalized identity and the supplied code", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const config = { clientId: "public-client", userPoolId: "us-east-1_test", region: "us-east-1" };
    await cognitoForgotPassword(config, " Alex@Example.com ");
    await cognitoConfirmForgotPassword(config, { email: " Alex@Example.com ", code: " 123456 ", password: "NewPassword1" });
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect((calls[0][1].headers as Record<string,string>)["X-Amz-Target"].endsWith(".ForgotPassword")).toBe(true);
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ ClientId: "public-client", Username: "alex@example.com" });
    expect((calls[1][1].headers as Record<string,string>)["X-Amz-Target"].endsWith(".ConfirmForgotPassword")).toBe(true);
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ ClientId: "public-client", Username: "alex@example.com", ConfirmationCode: "123456", Password: "NewPassword1" });
  });
});
