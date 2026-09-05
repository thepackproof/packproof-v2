import { ApiError } from "./types";

/** Bound the entire operation, including reading the response body. No automatic write retries. */
export async function withRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError("REQUEST_TIMEOUT", "The connection took too long. Check your connection and try again.", 408));
      controller.abort();
    }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer!); }
}
