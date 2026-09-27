import express, { type Router } from "express";
import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { DomainError } from "../domain/errors.js";
import { distributedRateLimit, requestBodyErrors, safeHttpError } from "../http/boundary.js";

export const PUBLIC_ANALYTICS_EVENT_TYPES = [
  "PAGE_VIEW", "SIGNUP_STARTED", "CTA_CLICK", "APP_STORE_CLICK", "PLAY_STORE_CLICK", "LOGIN_CLICK",
] as const;
export const PUBLIC_ANALYTICS_PATHS = [
  "/", "/about", "/contact", "/pricing", "/login", "/register", "/download",
  "/how-it-works", "/evidence-integrity", "/reviewers", "/integrations", "/platform-api",
  "/sellers", "/buyers", "/security", "/proof", "/proof-anywhere", "/privacy", "/terms",
] as const;
export const PUBLIC_ANALYTICS_DEVICE_CLASSES = ["desktop", "mobile", "tablet", "unknown"] as const;

interface AnalyticsDependencies { db: Database; clock: Clock }

/**
 * Public aggregate collection, mounted before authentication and the general body parser.
 * Deliberately cannot accept user/session IDs, URLs, queries, referrers, or user agents.
 */
export function publicAnalyticsRouter(deps: AnalyticsDependencies): Router {
  const router = express.Router();
  router.post("/analytics/events",
    distributedRateLimit(deps.db, { scope: "public-analytics", limit: 120, windowMs: 60_000 }),
    (req, _res, next) => {
      if (!req.is("application/json")) return next(new DomainError("UNSUPPORTED_CONTENT_TYPE", "Analytics events require JSON", 415));
      if (req.header("content-encoding") && req.header("content-encoding") !== "identity") return next(new DomainError("UNSUPPORTED_ENCODING", "Compressed analytics payloads are not accepted", 415));
      next();
    },
    express.json({ limit: "1kb", strict: true, inflate: false }),
    (req, res, next) => {
      void (async () => {
        const input: unknown = req.body;
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new DomainError("INVALID_ANALYTICS_EVENT", "Provide an allowed analytics event", 400);
        const body = input as Record<string, unknown>;
        if (Object.keys(body).some((key) => !["event", "path", "device"].includes(key)) ||
          !PUBLIC_ANALYTICS_EVENT_TYPES.includes(body.event as typeof PUBLIC_ANALYTICS_EVENT_TYPES[number]) ||
          !PUBLIC_ANALYTICS_PATHS.includes(body.path as typeof PUBLIC_ANALYTICS_PATHS[number]) ||
          (body.device !== undefined && !PUBLIC_ANALYTICS_DEVICE_CLASSES.includes(body.device as typeof PUBLIC_ANALYTICS_DEVICE_CLASSES[number]))) {
          throw new DomainError("INVALID_ANALYTICS_EVENT", "Event type, public path, and device class must use allowed values", 400);
        }
        // Check size again when another application parser already consumed the body.
        if (Buffer.byteLength(JSON.stringify(body), "utf8") > 1024) throw new DomainError("PAYLOAD_TOO_LARGE", "Analytics event is too large", 413);
        const day = deps.clock.now().toISOString().slice(0, 10);
        await deps.db.query(`INSERT INTO public_analytics_daily(event_type,path,device_class,day,event_count)
          VALUES($1,$2,$3,$4,1)
          ON CONFLICT(event_type,path,device_class,day)
          DO UPDATE SET event_count = LEAST(public_analytics_daily.event_count + 1, 9007199254740991)`,
        [body.event, body.path, body.device ?? "unknown", day]);
        res.status(202).json({ accepted: true });
      })().catch(next);
    },
  );
  router.use(requestBodyErrors);
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => safeHttpError(error, res));
  return router;
}
