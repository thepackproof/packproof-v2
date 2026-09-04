import { afterEach, expect, it, vi } from "vitest";
import { PackProofV2Client } from "../../mobile/src/v2-api.js";
import { toUserFacingError } from "../../mobile/src/copy/errors.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("releases a stuck mobile command with a retryable error and no automatic duplicate write", async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const fetcher = vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  });
  vi.stubGlobal("fetch", fetcher);
  const client = new PackProofV2Client({ baseUrl: "https://api.packproof.test", getToken: () => "token" });
  const pending = client.createTransaction({ itemTitle: "Card" }).catch((error) => error);
  await vi.advanceTimersByTimeAsync(30_001);
  const error = await pending;
  expect(error).toMatchObject({ code: "REQUEST_TIMEOUT", status: 408 });
  expect(signal.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(toUserFacingError(error)).toMatchObject({ code: "REQUEST_TIMEOUT", action: "retry" });
});
