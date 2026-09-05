import { afterEach, describe, expect, it, vi } from "vitest";
import { PackProofV2Client } from "../../mobile/src/v2-api.ts";
import { withRequestTimeout } from "../../mobile/src/request-timeout.ts";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const client = () => new PackProofV2Client({ baseUrl: "https://api.example", getToken: () => "token" });

describe("mobile request deadlines", () => {
  it("aborts and rejects a request even if the transport ignores cancellation", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init) => {
      signal = init.signal;
      return new Promise(() => undefined);
    }));
    const assertion = expect(client().getMe()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT", status: 408 });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a response body that stalls after headers arrive", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: () => new Promise(() => undefined) })));
    const assertion = expect(client().getMe()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("preserves API errors and clears the deadline on normal responses", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "PARTICIPANT_NOT_AUTHORIZED", message: "Denied" } }), { status: 403 })));
    await expect(client().getMe()).rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED", message: "Denied", status: 403 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns success without leaving a timer behind", async () => {
    vi.useFakeTimers();
    await expect(withRequestTimeout(async () => "done")).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends email subscriptions with the current token and preserves authorization errors", async () => {
    let token = "old-token";
    const api = new PackProofV2Client({ baseUrl: "https://api.example", getToken: () => token });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "PARTICIPANT_NOT_AUTHORIZED", message: "Denied" } }), { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    token = "refreshed-token";
    await expect(api.emailProof("proof_one", { email: "recipient@example.com", preference: "IMPORTANT", scope: "SUMMARY" })).rejects.toMatchObject({ code: "PARTICIPANT_NOT_AUTHORIZED", status: 403 });
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/proofs/proof_one/email-subscriptions", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer refreshed-token" }),
    }));
  });
});
