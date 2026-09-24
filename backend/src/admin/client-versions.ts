import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import type { ReleaseIdentity } from "../config.js";
import { DomainError } from "../domain/errors.js";
import { distributedRateLimit } from "../http/boundary.js";
import {
  getRange,
  metric,
  pagination,
  section,
  type Query,
  type Scalar,
} from "./analytics.js";

interface VersionDeps {
  db: Database;
  clock: Clock;
  releaseIdentity?: Partial<ReleaseIdentity>;
}
const PLATFORMS = ["ANDROID", "IOS", "WEB"] as const;
type Platform = (typeof PLATFORMS)[number];
interface Observation {
  platform: Platform;
  version: string | null;
  build: string | null;
}
export function parseClientVersion(value: unknown): Observation {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError(
      "INVALID_CLIENT_VERSION",
      "Provide a client release observation",
      400,
    );
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some(
      (k) => !["platform", "version", "build"].includes(k),
    ) ||
    !PLATFORMS.includes(body.platform as Platform)
  )
    throw new DomainError(
      "INVALID_CLIENT_VERSION",
      "Only a supported platform, version and build are accepted",
      400,
    );
  const version = body.version ?? null,
    build = body.build ?? null;
  if (
    version !== null &&
    (typeof version !== "string" ||
      version.length > 48 ||
      !/^\d{1,4}(?:\.\d{1,4}){1,3}(?:-[A-Za-z0-9][A-Za-z0-9.-]{0,24})?$/.test(
        version,
      ))
  )
    throw new DomainError(
      "INVALID_CLIENT_VERSION",
      "Version must be a bounded release number",
      400,
    );
  if (
    build !== null &&
    (typeof build !== "string" ||
      build.length > 64 ||
      !(body.platform === "WEB"
        ? /^[a-f0-9]{7,64}$/i.test(build)
        : /^\d{1,10}(?:\.\d{1,10}){0,2}$/.test(build)))
  )
    throw new DomainError(
      "INVALID_CLIENT_VERSION",
      "Build must be a release number, or a web commit SHA",
      400,
    );
  if (version === null && build === null)
    throw new DomainError(
      "INVALID_CLIENT_VERSION",
      "At least one observed release identifier is required",
      400,
    );
  return {
    platform: body.platform as Platform,
    version: version as string | null,
    build: build as string | null,
  };
}
/** Authenticated, self-reported and non-authoritative. At most three rows per account. */
export function clientVersionRouter(deps: VersionDeps) {
  const r = express.Router();
  r.post(
    "/me/client-version",
    (req: Request, _res: Response, next: NextFunction) => {
      if (!req.packproofUserId)
        return next(
          new DomainError(
            "UNAUTHENTICATED",
            "Sign in to record a client release",
            401,
          ),
        );
      next();
    },
    distributedRateLimit(deps.db, {
      scope: "client-version",
      limit: 24,
      windowMs: 3600000,
      subject: (req) => req.packproofUserId!,
    }),
    (req: Request, res: Response, next: NextFunction) => {
      void (async () => {
        const observation = parseClientVersion(req.body);
        const now = deps.clock.now().toISOString();
        await deps.db.query(
          `INSERT INTO client_version_activity(user_id,platform,app_version,build,first_seen_at,last_seen_at)
    VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(user_id,platform) DO UPDATE SET
    app_version=EXCLUDED.app_version,build=EXCLUDED.build,
    first_seen_at=CASE WHEN (client_version_activity.app_version,client_version_activity.build) IS DISTINCT FROM (EXCLUDED.app_version,EXCLUDED.build) THEN EXCLUDED.first_seen_at ELSE client_version_activity.first_seen_at END,
    last_seen_at=EXCLUDED.last_seen_at
    WHERE (client_version_activity.app_version,client_version_activity.build) IS DISTINCT FROM (EXCLUDED.app_version,EXCLUDED.build)
      OR client_version_activity.last_seen_at<EXCLUDED.last_seen_at-INTERVAL '5 minutes'`,
          [
            req.packproofUserId,
            observation.platform,
            observation.version,
            observation.build,
            now,
          ],
        );
        res.status(202).json({ accepted: true });
      })().catch(next);
    },
  );
  return r;
}

function safeRelease(value: unknown, max = 64): string | null {
  return typeof value === "string" &&
    value.length <= max &&
    /^[a-zA-Z0-9._-]+$/.test(value)
    ? value
    : null;
}
export async function versionsSection(deps: VersionDeps, q: Query) {
  const range = getRange(deps.clock, q),
    page = pagination(q);
  const release = deps.releaseIdentity;
  const releaseVersion = safeRelease(release?.version, 48),
    releaseBuild = safeRelease(release?.commit);
  const rows = (
    await deps.db.query(
      `WITH releases AS(
 SELECT platform,app_version AS version,build,COUNT(*)::integer AS users,MIN(first_seen_at) AS first_seen,MAX(last_seen_at) AS last_seen FROM client_version_activity WHERE last_seen_at >= $1 AND last_seen_at < $2 GROUP BY platform,app_version,build
 ), sessions AS(
 SELECT c.actor_user_id,c.created_at,CASE WHEN e.context_json->'capabilities'->>'surface' IN ('ANDROID','IOS','WEB','WAREHOUSE') THEN e.context_json->'capabilities'->>'surface' WHEN c.identifier_policy->>'surface' IN ('ANDROID','IOS','WEB','WAREHOUSE') THEN c.identifier_policy->>'surface' WHEN c.client='WEB_CAMERA' THEN 'WEB' ELSE 'NATIVE_UNKNOWN' END AS platform FROM capture_sessions c LEFT JOIN capture_engine_sessions e ON e.session_id=c.id WHERE c.created_at >= $1 AND c.created_at < $2
 ), rows AS(
 SELECT platform,version,build,users,first_seen,last_seen,NULL::numeric AS error_rate,'available'::text AS availability,'Latest client-reported release'::text AS source FROM releases
 UNION ALL SELECT v.platform,NULL::text,NULL::text,NULL::integer,NULL::timestamptz,NULL::timestamptz,NULL::numeric,'unavailable','No app release reported in this window' FROM (VALUES('ANDROID'),('IOS'),('WEB')) v(platform) WHERE NOT EXISTS(SELECT 1 FROM releases r WHERE r.platform=v.platform)
 UNION ALL SELECT platform,NULL::text,NULL::text,COUNT(DISTINCT actor_user_id)::integer,MIN(created_at),MAX(created_at),NULL::numeric,'partial','Capture platform only; app version was not recorded' FROM sessions GROUP BY platform
 UNION ALL SELECT 'API',$3::text,$4::text,NULL::integer,NULL::timestamptz,NULL::timestamptz,NULL::numeric,CASE WHEN $3::text IS NOT NULL OR $4::text IS NOT NULL THEN 'available' ELSE 'unavailable' END,'Current backend release; not the web deployment' WHERE $5::boolean
 ) SELECT platform,version,build,users,first_seen,last_seen,error_rate,availability,source,COUNT(*) OVER() AS __total FROM rows ORDER BY platform,source,version,build LIMIT $6 OFFSET $7`,
      [
        range.from,
        range.to,
        releaseVersion,
        releaseBuild,
        Boolean(release),
        page.pageSize,
        (page.page - 1) * page.pageSize,
      ],
    )
  ).rows;
  const s = section(
    "Client versions",
    "Latest observed app release per account and declared platform. Capture-only observations remain separate.",
    deps.clock,
    rows,
    [
      ["platform", "Platform"],
      ["version", "App/API version"],
      ["build", "Build / commit"],
      ["users", "Observed users"],
      ["first_seen", "First observed"],
      ["last_seen", "Last observed"],
      ["error_rate", "Error rate"],
      ["source", "Source"],
    ],
    page,
    Number(rows[0]?.__total ?? 0),
  );
  const accounts = (
    await deps.db.query(
      `SELECT COUNT(DISTINCT user_id)::integer AS users,COUNT(*)::integer AS observations FROM client_version_activity WHERE last_seen_at >= $1 AND last_seen_at < $2`,
      [range.from, range.to],
    )
  ).rows[0];
  s.metrics = [
    metric("version_users", "Users reporting an app release", accounts.users),
    metric(
      "version_observations",
      "Account/platform observations",
      accounts.observations,
    ),
    metric("version_error_rate", "Errors by release", null, null, {
      unit: "percent",
      note: "Exceptions are not attributed to client release; no rate is inferred.",
    }),
  ];
  s.notices = [
    "Release identifiers are client-reported; they do not prove device integrity or operating-system identity. Users are counted once per platform at their latest reported release, so one person can appear across multiple platforms.",
    "A later release report replaces that account/platform’s prior release. This is a current activity view, not a historical install census. Same-version activity is persisted at most once every five minutes.",
    "Capture-only rows are separate source observations and must not be added to release-user totals. Legacy native camera sessions cannot distinguish Android from iOS.",
    "API version and commit identify this backend process. A web deployment timestamp is not available from client observations; first/last observed timestamps are not deployment times.",
  ];
  return s;
}
