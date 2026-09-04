import type { ErrorRequestHandler, RequestHandler } from "express";

/** Apply before every router, including provider and notification routes. */
export function httpBoundary(corsOrigins: readonly string[]): RequestHandler {
  return (req, res, next) => {
    // Proofs, bearer viewing links, and account responses must never be cached.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.vary("Origin");
    const origin = req.header("Origin");
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Body-parser errors must use the same safe JSON contract as domain errors. */
export const requestBodyErrors: ErrorRequestHandler = (error, _req, res, next) => {
  const codes: Record<string, { status: number; code: string; message: string }> = {
    "entity.parse.failed": { status: 400, code: "INVALID_JSON", message: "Request body must be valid JSON" },
    "entity.too.large": { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" },
    "encoding.unsupported": { status: 415, code: "UNSUPPORTED_ENCODING", message: "Request encoding is not supported" },
    "charset.unsupported": { status: 415, code: "UNSUPPORTED_CHARSET", message: "Request charset is not supported" },
  };
  const mapped = codes[error?.type];
  if (!mapped) return next(error);
  res.status(mapped.status).json({ error: { code: mapped.code, message: mapped.message } });
};
