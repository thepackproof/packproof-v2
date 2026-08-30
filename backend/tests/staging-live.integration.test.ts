import { describe, expect, it } from "vitest";

const stagingUrl = process.env.PACKPROOF_STAGING_URL?.replace(/\/$/, "");
const enabled = process.env.PACKPROOF_STAGING_INTEGRATION === "1" && Boolean(stagingUrl);

describe.skipIf(!enabled)("opt-in live staging deployment", () => {
  it("serves unauthenticated health over the configured staging URL", async () => {
    const response = await fetch(`${stagingUrl}/health`);
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("does not expose development login in Cognito staging mode", async () => {
    const response = await fetch(`${stagingUrl}/auth/dev/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "should-not-work" }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
