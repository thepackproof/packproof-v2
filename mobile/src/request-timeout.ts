export class RequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  readonly status = 408;
  constructor() { super("The connection took too long. Please try again."); this.name = "RequestTimeoutError"; }
}

export async function withRequestTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(new RequestTimeoutError()); controller.abort(); }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer!); }
}
