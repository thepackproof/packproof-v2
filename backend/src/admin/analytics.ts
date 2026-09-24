import type { Database } from "../db/database.js";
import type { Clock } from "../clock.js";
import { DomainError } from "../domain/errors.js";
export type Scalar = string | number | boolean | null;
export interface Metric {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  unit?: "count" | "percent" | "bytes" | "currency" | "ms";
  status: "available" | "unavailable";
  note?: string;
  href?: string;
}
export interface Section {
  title: string;
  description: string;
  updatedAt: string;
  metrics: Metric[];
  columns: Array<{
    key: string;
    label: string;
  }>;
  rows: Array<Record<string, Scalar>>;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
  notices: string[];
}
export interface Range {
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
}
export type Query = Record<string, unknown>;
const DAY = 86400000;
export function textQuery(q: Query, key: string, max = 200): string {
  const v = q[key];
  if (v === undefined) return "";
  if (typeof v !== "string" || v.length > max)
    throw new DomainError("INVALID_ADMIN_QUERY", `Invalid ${key}`, 400);
  return v.trim();
}
export function pagination(q: Query) {
  function integer(key: string, fallback: number, max: number) {
    const value = textQuery(q, key, 8);
    if (!value) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max)
      throw new DomainError("INVALID_ADMIN_QUERY", `Invalid ${key}`, 400);
    return Number(value);
  }
  return {
    page: integer("page", 1, 10000),
    pageSize: integer("pageSize", 25, 100),
  };
}
export function getRange(clock: Clock, q: Query = {}): Range {
  const now = clock.now();
  const period = textQuery(q, "period", 10) || "7d";
  const days: Record<string, number> = {
    today: 1,
    "7d": 7,
    "30d": 30,
    "90d": 90,
    "1y": 365,
    all: 3650,
  };
  if (!(period in days))
    throw new DomainError("INVALID_ADMIN_QUERY", "Unsupported period", 400);
  let to = now.getTime();
  let from =
    period === "today"
      ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      : period === "all"
        ? 0
        : to - days[period] * DAY;
  const f = textQuery(q, "from", 40),
    t = textQuery(q, "to", 40);
  if (Boolean(f) !== Boolean(t))
    throw new DomainError(
      "INVALID_ADMIN_QUERY",
      "Both from and to are required",
      400,
    );
  if (f) {
    from = Date.parse(f);
    to = Date.parse(t);
  }
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    from >= to ||
    to - from > (period === "all" && !f ? 100000 : 3660) * DAY ||
    to > now.getTime() + DAY
  )
    throw new DomainError("INVALID_ADMIN_QUERY", "Invalid date range", 400);
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    previousFrom: new Date(from - (to - from)).toISOString(),
    previousTo: new Date(from).toISOString(),
  };
}
export function metric(
  key: string,
  label: string,
  value: unknown,
  previous: unknown = null,
  extra: Partial<Metric> = {},
): Metric {
  return {
    key,
    label,
    value: value === null ? null : Number(value),
    previous: previous === null ? null : Number(previous),
    status: value === null ? "unavailable" : "available",
    ...extra,
  };
}
export function section(
  title: string,
  description: string,
  clock: Clock,
  rows: Array<Record<string, unknown>>,
  columns: Array<[string, string]>,
  page = { page: 1, pageSize: Math.max(1, rows.length) },
  total = rows.length,
): Section {
  return {
    title,
    description,
    updatedAt: clock.now().toISOString(),
    metrics: [],
    columns: columns.map(([key, label]) => ({ key, label })),
    rows: rows.map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([k]) => k !== "__total")
          .map(([k, v]) => [
            k,
            v instanceof Date
              ? v.toISOString()
              : v === undefined
                ? null
                : typeof v === "string" ||
                    typeof v === "number" ||
                    typeof v === "boolean" ||
                    v === null
                  ? v
                  : String(v),
          ]),
      ),
    ),
    pagination: { ...page, total },
    notices: [],
  };
}
export const ACTIVE_SQL = `SELECT actor_user_id AS user_id,created_at FROM audit_events WHERE actor_user_id IS NOT NULL UNION ALL SELECT actor_user_id AS user_id,created_at FROM account_audit_events WHERE actor_user_id IS NOT NULL`;
const SOURCES: Record<
  string,
  {
    label: string;
    sql: string;
    distinct?: string;
  }
> = {
  registrations: {
    label: "Registrations",
    sql: "SELECT id,created_at FROM users",
  },
  active_users: {
    label: "Users with recorded activity",
    sql: ACTIVE_SQL,
    distinct: "user_id",
  },
  proofs_created: {
    label: "Proofs created",
    sql: "SELECT id,created_at FROM proofs",
  },
  proofs_finalized: {
    label: "Proofs finalized",
    sql: "SELECT id,finalized_at AS created_at FROM proofs WHERE finalized_at IS NOT NULL",
  },
  evidence_captures: {
    label: "Evidence captures committed",
    sql: "SELECT id,committed_at AS created_at FROM evidence WHERE validation_status='COMMITTED' AND capture_session_id IS NOT NULL UNION ALL SELECT id,committed_at AS created_at FROM commerce_stage_evidence WHERE committed_at IS NOT NULL AND capture_session_id IS NOT NULL",
  },
  successful_uploads: {
    label: "Committed uploads",
    sql: "SELECT id,committed_at AS created_at FROM evidence WHERE validation_status='COMMITTED' UNION ALL SELECT id,committed_at AS created_at FROM commerce_stage_evidence WHERE committed_at IS NOT NULL",
  },
  failed_uploads: {
    label: "Rejected uploads",
    sql: "SELECT id,created_at FROM evidence WHERE validation_status='REJECTED'",
  },
  proof_views: {
    label: "Recorded Proof viewer opens",
    sql: "SELECT id,created_at FROM audit_events WHERE event_type IN ('PROOF_VIEWED_VIA_ACCESS_LINK','PROOF_ACCESSED','SHARED_PROOF_VIEWED')",
  },
  shared_links: {
    label: "Share links created",
    sql: "SELECT id,created_at FROM proof_access_links",
  },
  marketplace_imports: {
    label: "Marketplace orders imported",
    sql: "SELECT id,first_seen_at AS created_at FROM commerce_order_records WHERE transaction_id IS NOT NULL",
  },
  carrier_events: {
    label: "Carrier observations",
    sql: "SELECT id,created_at FROM shipment_events",
  },
  api_requests: {
    label: "Recorded public API requests",
    sql: "SELECT id,created_at FROM api_request_audit",
  },
};
export async function metricCounts(db: Database, key: string, range: Range) {
  const source = SOURCES[key];
  if (!source)
    throw new DomainError("INVALID_ADMIN_METRIC", "Unsupported metric", 400);
  const expr = source.distinct
    ? `COUNT(DISTINCT ${source.distinct})`
    : "COUNT(*)";
  const result = await db.query<{
    current: string;
    previous: string;
  }>(
    `SELECT ${expr} FILTER(WHERE created_at >= $1 AND created_at < $2) AS current,${expr} FILTER(WHERE created_at >= $3 AND created_at < $1) AS previous FROM (${source.sql}) source WHERE created_at >= $3 AND created_at < $2`,
    [range.from, range.to, range.previousFrom],
  );
  return metric(
    key,
    source.label,
    result.rows[0].current,
    result.rows[0].previous,
  );
}
export async function trend(db: Database, clock: Clock, q: Query) {
  const range = getRange(clock, q);
  const key = textQuery(q, "metric", 40) || "proofs_created";
  const source = SOURCES[key];
  if (!source)
    throw new DomainError("INVALID_ADMIN_METRIC", "Unsupported metric", 400);
  const duration = Date.parse(range.to) - Date.parse(range.from);
  const count = Math.min(90, Math.max(1, Math.ceil(duration / DAY)));
  const bucket = duration / count;
  const expr = source.distinct
    ? `COUNT(DISTINCT ${source.distinct})`
    : "COUNT(*)";
  const rows = (
    await db.query<{
      period: string;
      bucket: number;
      value: string;
    }>(
      `SELECT CASE WHEN created_at >= $1 THEN 'current' ELSE 'previous' END AS period,FLOOR(EXTRACT(EPOCH FROM (created_at - CASE WHEN created_at >= $1 THEN $1::timestamptz ELSE $3::timestamptz END))*1000/$4)::integer AS bucket,${expr} AS value FROM (${source.sql}) source WHERE created_at >= $3 AND created_at < $2 GROUP BY 1,2 ORDER BY 2`,
      [range.from, range.to, range.previousFrom, bucket],
    )
  ).rows;
  const lookup = new Map(
    rows.map((r) => [`${r.period}:${r.bucket}`, Number(r.value)]),
  );
  return {
    metric: key,
    label: source.label,
    range,
    updatedAt: clock.now().toISOString(),
    status: "available",
    bucketMs: bucket,
    bucketLabel:
      bucket <= DAY
        ? "Daily interval"
        : `${Math.round((bucket / DAY) * 10) / 10}-day interval`,
    note:
      key === "api_requests"
        ? "Public integration API only; general website/API request instrumentation is not configured."
        : key === "active_users"
          ? "Distinct actors in recorded product/account events; this does not measure every login."
          : undefined,
    points: Array.from({ length: count }, (_, i) => ({
      date: new Date(Date.parse(range.from) + i * bucket).toISOString(),
      endDate: new Date(
        Date.parse(range.from) + (i + 1) * bucket,
      ).toISOString(),
      value: lookup.get(`current:${i}`) ?? 0,
      previous: lookup.get(`previous:${i}`) ?? 0,
    })),
  };
}
export async function analyticsSection(
  db: Database,
  clock: Clock,
  q: Query,
): Promise<Section> {
  const range = getRange(clock, q);
  const view = textQuery(q, "view", 30) || "product";
  if (!["product", "usage", "acquisition", "cohorts"].includes(view))
    throw new DomainError(
      "INVALID_ADMIN_QUERY",
      "Unsupported analytics view",
      400,
    );
  if (view === "usage") {
    const rows = (
      await db.query(
        `SELECT 'Proof workflow' AS dimension,workflow_type AS category,COUNT(*)::integer AS records,COUNT(*) FILTER(WHERE status='FINALIZED')::integer AS completed FROM proofs WHERE created_at >= $1 AND created_at < $2 GROUP BY workflow_type UNION ALL SELECT 'Capture client' AS dimension,client AS category,COUNT(*)::integer AS records,COUNT(*) FILTER(WHERE state='COMMITTED')::integer AS completed FROM capture_sessions WHERE created_at >= $1 AND created_at < $2 GROUP BY client UNION ALL SELECT 'Proof origin' AS dimension,CASE WHEN EXISTS(SELECT 1 FROM commerce_order_records o WHERE o.transaction_id=p.transaction_id) THEN 'Marketplace import' ELSE 'Direct/API creation' END AS category,COUNT(*)::integer AS records,COUNT(*) FILTER(WHERE status='FINALIZED')::integer AS completed FROM proofs p WHERE p.created_at >= $1 AND p.created_at < $2 GROUP BY 2 ORDER BY dimension,category`,
        [range.from, range.to],
      )
    ).rows;
    const owners = (
      await db.query(
        `WITH created AS (SELECT t.created_by,COUNT(*) AS proofs FROM proofs p JOIN transactions t ON t.id=p.transaction_id WHERE p.created_at >= $1 AND p.created_at < $2 GROUP BY t.created_by) SELECT COUNT(*) FILTER(WHERE proofs>=2)::integer AS two,COUNT(*) FILTER(WHERE proofs>=5)::integer AS five,COUNT(*) FILTER(WHERE proofs>=10)::integer AS ten,COUNT(*) FILTER(WHERE proofs>=25)::integer AS twentyfive FROM created`,
        [range.from, range.to],
      )
    ).rows[0];
    const invites = (
      await db.query(
        `SELECT COUNT(*) AS sent,COUNT(*) FILTER(WHERE accepted_at IS NOT NULL AND accepted_at<$2) AS accepted FROM invitations WHERE created_at >= $1 AND created_at < $2`,
        [range.from, range.to],
      )
    ).rows[0];
    const completed = (
      await db.query(
        `SELECT AVG(EXTRACT(EPOCH FROM(finalized_at-created_at))*1000) AS completion_ms FROM proofs WHERE finalized_at >= $1 AND finalized_at < $2`,
        [range.from, range.to],
      )
    ).rows[0];
    const s = section(
      "Product usage",
      "Observed workflow, capture client and origin within the selected window.",
      clock,
      rows,
      [
        ["dimension", "Dimension"],
        ["category", "Category"],
        ["records", "Records"],
        ["completed", "Committed/finalized now"],
      ],
    );
    s.metrics = [
      metric("owners_two", "Owners with 2+ new Proofs", owners.two),
      metric("owners_five", "Owners with 5+ new Proofs", owners.five),
      metric("owners_ten", "Owners with 10+ new Proofs", owners.ten),
      metric(
        "owners_twentyfive",
        "Owners with 25+ new Proofs",
        owners.twentyfive,
      ),
      metric(
        "invite_acceptance",
        "Invite cohort acceptance",
        Number(invites.sent)
          ? (Number(invites.accepted) / Number(invites.sent)) * 100
          : null,
        null,
        { unit: "percent" },
      ),
      metric(
        "completion_ms",
        "Average finalized Proof time",
        completed.completion_ms,
        null,
        { unit: "ms" },
      ),
    ];
    s.notices = [
      "Owners may have automatically imported Proofs. Capture client is the declared authorized workflow, not a verified operating system or app version.",
      "Completion counts in the table reflect present record state; invitations are restricted to acceptance observed by the selected end date.",
    ];
    return s;
  }
  if (view === "acquisition") {
    const rows = (
      await db.query(
        `SELECT event_type,path,device_class,SUM(event_count)::bigint AS events FROM public_analytics_daily WHERE day >= $1::timestamptz::date AND day <= ($2::timestamptz - INTERVAL '1 millisecond')::date GROUP BY event_type,path,device_class ORDER BY events DESC,event_type,path LIMIT 300`,
        [range.from, range.to],
      )
    ).rows;
    const s = section(
      "Website activity",
      "Anonymous daily event totals from first-party instrumentation; UTC calendar days.",
      clock,
      rows.slice(
        (pagination(q).page - 1) * pagination(q).pageSize,
        pagination(q).page * pagination(q).pageSize,
      ),
      [
        ["event_type", "Event"],
        ["path", "Page"],
        ["device_class", "Device"],
        ["events", "Events"],
      ],
      pagination(q),
      rows.length,
    );
    const total = (kind: string) =>
      rows
        .filter((r) => r.event_type === kind)
        .reduce((n, r) => n + Number(r.events), 0);
    s.metrics = [
      metric("page_views", "Recorded page views", total("PAGE_VIEW")),
      metric("signup_started", "Sign-up clicks", total("SIGNUP_STARTED")),
      metric("cta_clicks", "CTA clicks", total("CTA_CLICK")),
      metric("app_store_clicks", "App Store clicks", total("APP_STORE_CLICK")),
      metric(
        "play_store_clicks",
        "Google Play clicks",
        total("PLAY_STORE_CLICK"),
      ),
    ];
    s.notices = [
      "Counts begin after instrumentation is deployed. Browser-reported events may include repeated visits and bots; these are not unique visitors, sessions or attributed registration conversions.",
      "Only daily totals are stored. Date filters include whole UTC days; referrers, geography and cross-session attribution are unavailable.",
    ];
    return s;
  }
  if (view === "cohorts") {
    const rows = (
      await db.query(
        `WITH cohorts AS (SELECT id,created_at,date_trunc('week',created_at) AS week FROM users WHERE created_at >= $1 AND created_at < $2), activity AS (${ACTIVE_SQL}) SELECT c.week AS cohort,COUNT(DISTINCT c.id)::integer AS users,COUNT(DISTINCT c.id) FILTER(WHERE c.created_at < $2::timestamptz-INTERVAL '2 days')::integer AS day1_eligible,COUNT(DISTINCT c.id) FILTER(WHERE c.created_at < $2::timestamptz-INTERVAL '2 days' AND EXISTS(SELECT 1 FROM activity a WHERE a.user_id=c.id AND a.created_at >= c.created_at+INTERVAL '1 day' AND a.created_at<c.created_at+INTERVAL '2 days'))::integer AS day1_returned,COUNT(DISTINCT c.id) FILTER(WHERE c.created_at < $2::timestamptz-INTERVAL '8 days')::integer AS day7_eligible,COUNT(DISTINCT c.id) FILTER(WHERE c.created_at < $2::timestamptz-INTERVAL '8 days' AND EXISTS(SELECT 1 FROM activity a WHERE a.user_id=c.id AND a.created_at>=c.created_at+INTERVAL '7 days' AND a.created_at<c.created_at+INTERVAL '8 days'))::integer AS day7_returned,COUNT(DISTINCT c.id) FILTER(WHERE c.created_at < $2::timestamptz-INTERVAL '31 days')::integer AS day30_eligible,COUNT(DISTINCT c.id) FILTER(WHERE c.created_at < $2::timestamptz-INTERVAL '31 days' AND EXISTS(SELECT 1 FROM activity a WHERE a.user_id=c.id AND a.created_at>=c.created_at+INTERVAL '30 days' AND a.created_at<c.created_at+INTERVAL '31 days'))::integer AS day30_returned FROM cohorts c GROUP BY c.week ORDER BY c.week DESC LIMIT 100`,
        [range.from, range.to],
      )
    ).rows;
    const s = section(
      "Retention cohorts",
      "Registration weeks, UTC; return activity on the exact elapsed day. Immature users are excluded from eligible denominators.",
      clock,
      rows,
      [
        ["cohort", "Registration week"],
        ["users", "Users"],
        ["day1_returned", "Day 1 returned"],
        ["day1_eligible", "Day 1 eligible"],
        ["day7_returned", "Day 7 returned"],
        ["day7_eligible", "Day 7 eligible"],
        ["day30_returned", "Day 30 returned"],
        ["day30_eligible", "Day 30 eligible"],
      ],
    );
    s.notices = [
      "Activity means an observed product/account event, not a inferred login. Up to 100 newest registration weeks.",
    ];
    return s;
  }
  const rows = (
    await db.query<{
      registered: number;
      created: number;
      captured: number;
      completed: number;
    }>(
      `WITH cohort AS (SELECT id FROM users WHERE created_at >= $1 AND created_at < $2) SELECT COUNT(*)::integer AS registered,COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM transactions t JOIN proofs p ON p.transaction_id=t.id WHERE t.created_by=c.id AND p.created_at<$2))::integer AS created,COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM transactions t JOIN proofs p ON p.transaction_id=t.id JOIN evidence e ON e.proof_id=p.id WHERE t.created_by=c.id AND e.submitted_by=c.id AND e.validation_status='COMMITTED' AND e.capture_session_id IS NOT NULL AND e.committed_at<$2))::integer AS captured,COUNT(*) FILTER(WHERE EXISTS(SELECT 1 FROM transactions t JOIN proofs p ON p.transaction_id=t.id JOIN evidence e ON e.proof_id=p.id WHERE t.created_by=c.id AND e.submitted_by=c.id AND e.validation_status='COMMITTED' AND e.capture_session_id IS NOT NULL AND e.committed_at<=p.finalized_at AND p.finalized_at<$2))::integer AS completed FROM cohort c`,
      [range.from, range.to],
    )
  ).rows[0];
  const stages = [
    ["registered", "Account created"],
    ["created", "First Proof created"],
    ["captured", "First capture committed"],
    ["completed", "First captured Proof finalized"],
  ] as const;
  let previous: number | null = null;
  const funnel = stages.map(([key, label]) => {
    const value = Number(rows[key]);
    const result = {
      stage: label,
      users: value,
      conversion:
        previous === null || previous === 0
          ? null
          : Math.round((value / previous) * 1000) / 10,
    };
    previous = value;
    return result;
  });
  const s = section(
    "Product analytics",
    "Registration cohort activation as observed by the end of the selected window.",
    clock,
    funnel,
    [
      ["stage", "Funnel stage"],
      ["users", "Users"],
      ["conversion", "Conversion from prior stage (%)"],
    ],
  );
  s.metrics = await Promise.all(
    [
      "registrations",
      "active_users",
      "proofs_created",
      "proofs_finalized",
      "evidence_captures",
      "marketplace_imports",
      "proof_views",
      "shared_links",
    ].map((k) => metricCounts(db, k, range)),
  );
  s.notices = [
    "Visitor → registration attribution, app versions and exact login retention are unavailable until corresponding telemetry is collected. Product activity excludes automatic imports without an actor.",
    "Use the Cohorts view for Day 1, Day 7 and Day 30 retention; values only include users with a fully elapsed observation day.",
  ];
  return s;
}
