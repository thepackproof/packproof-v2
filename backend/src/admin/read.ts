import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import type { ObjectStore } from "../s3/object-store.js";
import { DomainError } from "../domain/errors.js";
import { sha256Hex } from "../hash.js";
import { adminErrorActions } from "./error-actions.js";
import { adminUserActions } from "./actions.js";
import {
  adminIntegrationActions,
  adminWebhookDeliveryActions,
  type AdminIntegrationState,
  type AdminIntegrationSyncState,
  type AdminWebhookDeliveryState,
} from "./integration-actions.js";
import { getAccountUsageSummary } from "../billing/usage-ledger.js";
import {
  getRange,
  metric,
  metricCounts,
  pagination,
  section,
  textQuery,
  type Metric,
  type Query,
  type Section,
  ACTIVE_SQL,
} from "./analytics.js";
export interface AdminReadDeps {
  db: Database;
  clock: Clock;
  objectStore: ObjectStore;
  releaseIdentity?: {
    environment?: string;
    buildSha?: string;
    version?: string | null;
    commit?: string | null;
  };
  config?: Record<string, unknown>;
}
function sortOrder(
  q: Query,
  allowed: Record<string, string>,
  fallback: string,
) {
  const key = textQuery(q, "sort", 40) || fallback;
  const direction = (textQuery(q, "direction", 4) || "desc").toLowerCase();
  if (!allowed[key] || !["asc", "desc"].includes(direction))
    throw new DomainError("INVALID_ADMIN_QUERY", "Unsupported sort order", 400);
  return `${allowed[key]} ${direction.toUpperCase()} NULLS LAST`;
}
const href = (type: string, id: unknown) =>
  `/admin/${type}/${encodeURIComponent(String(id))}`;
const escaped = (s: string) => s.replace(/[\\%_]/g, "\\$&");
export function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_.:-]{0,79}$/.test(value)
    ? value
    : "OPERATION_FAILED";
}
function count(rows: Array<Record<string, unknown>>) {
  return Number(rows[0]?.__total ?? 0);
}
const EMAIL = `(SELECT email_normalized FROM user_verified_contacts WHERE user_id=u.id ORDER BY verified_at DESC LIMIT 1)`;
const EVIDENCE = `SELECT id,proof_id,submitted_by,content_type,byte_size,sha256,created_at,committed_at,validation_status,evidence_type,capture_origin,capture_session_id,object_key,object_version_id,'ROOT'::text AS source FROM evidence UNION ALL SELECT e.id,s.proof_id,s.actor_user_id AS submitted_by,e.content_type,e.byte_size,e.sha256,e.created_at,e.committed_at,CASE WHEN e.committed_at IS NOT NULL THEN 'COMMITTED' WHEN e.discarded_at IS NOT NULL THEN 'DISCARDED' ELSE 'PENDING' END AS validation_status,s.stage_type AS evidence_type,e.capture_origin,e.capture_session_id,e.object_key,e.object_version_id,'STAGE'::text AS source FROM commerce_stage_evidence e JOIN commerce_stages s ON s.id=e.stage_id`;
export async function usersSection(
  deps: AdminReadDeps,
  q: Query,
): Promise<Section> {
  const { db, clock } = deps;
  const range = getRange(clock, q),
    useDates = Boolean(q.period || q.from || q.to);
  const p = pagination(q),
    search = textQuery(q, "q"),
    status = textQuery(q, "status", 30);
  if (
    status &&
    !["ACTIVE", "DISABLED", "DELETION_REQUESTED", "DELETED"].includes(status)
  )
    throw new DomainError("INVALID_ADMIN_QUERY", "Invalid account status", 400);
  const rows = (
    await db.query(
      `SELECT u.id,u.username,u.display_name,u.status,u.admin_version AS "adminVersion",u.created_at,${EMAIL} AS email,(SELECT MAX(created_at) FROM (${ACTIVE_SQL}) a WHERE a.user_id=u.id) AS last_active,(SELECT COUNT(*)::integer FROM proof_participants pp WHERE pp.user_id=u.id) AS proof_count,(SELECT COUNT(*)::integer FROM proof_participants pp JOIN proofs p ON p.id=pp.proof_id WHERE pp.user_id=u.id AND p.status='FINALIZED') AS completed_count,(SELECT COUNT(*)::integer FROM connected_accounts ca WHERE ca.user_id=u.id AND ca.status='CONNECTED') AS connections,COUNT(*) OVER() AS __total FROM users u WHERE ($1='' OR u.id=$1 OR u.username ILIKE $2 ESCAPE '\\' OR u.display_name ILIKE $2 ESCAPE '\\' OR EXISTS(SELECT 1 FROM user_verified_contacts c WHERE c.user_id=u.id AND c.email_normalized ILIKE $2 ESCAPE '\\') OR EXISTS(SELECT 1 FROM auth_identities a WHERE a.user_id=u.id AND a.provider_subject=$1) OR EXISTS(SELECT 1 FROM proof_participants pp WHERE pp.user_id=u.id AND pp.proof_id=$1)) AND ($3='' OR u.status=$3) AND (NOT $6::boolean OR (u.created_at >= $7 AND u.created_at<$8)) ORDER BY ${sortOrder(q, { created_at: "u.created_at", username: "u.username", status: "u.status", last_active: "last_active", proof_count: "proof_count" }, "created_at")},u.id LIMIT $4 OFFSET $5`,
      [
        search,
        `%${escaped(search)}%`,
        status,
        p.pageSize,
        (p.page - 1) * p.pageSize,
        useDates,
        range.from,
        range.to,
      ],
    )
  ).rows;
  const s = section(
    "Users",
    "Account identity and observed product activity.",
    clock,
    rows.map((r) => ({ ...r, href: href("users", r.id) })),
    [
      ["display_name", "Name"],
      ["username", "Username"],
      ["email", "Verified email"],
      ["status", "Status"],
      ["created_at", "Registered"],
      ["last_active", "Last product activity"],
      ["proof_count", "Proofs"],
      ["completed_count", "Finalized"],
      ["connections", "Connections"],
    ],
    p,
    count(rows),
  );
  s.notices = [
    "Only verified email contacts are available. Last product activity is not the last login.",
  ];
  return s;
}
export async function proofsSection(
  deps: AdminReadDeps,
  q: Query,
): Promise<Section> {
  const { db, clock } = deps;
  const p = pagination(q),
    search = textQuery(q, "q"),
    status = textQuery(q, "status", 40),
    owner = textQuery(q, "userId"),
    workflow = textQuery(q, "workflow", 40),
    carrier = textQuery(q, "carrier", 40),
    marketplace = textQuery(q, "marketplace", 40);
  const valid = [
    "OPEN",
    "AWAITING_PARTICIPANT",
    "READY_FOR_EVIDENCE",
    "EVIDENCE_COMMITTED",
    "FINALIZED",
    "needs_attention",
    "shared",
    "upload_interrupted",
  ];
  if (status && !valid.includes(status))
    throw new DomainError("INVALID_ADMIN_QUERY", "Invalid Proof status", 400);
  const range = getRange(clock, q);
  const useDates = Boolean(q.period || q.from || q.to);
  const rows = (
    await db.query(
      `SELECT p.id,p.transaction_id,p.status,p.workflow_type,p.created_at,p.finalized_at,t.created_by AS user_id,t.item_title,s.tracking_number,s.carrier,(SELECT COUNT(*)::integer FROM evidence e WHERE e.proof_id=p.id AND e.validation_status='COMMITTED') AS evidence_count,COUNT(*) OVER() AS __total FROM proofs p JOIN transactions t ON t.id=p.transaction_id LEFT JOIN transaction_shipping s ON s.transaction_id=t.id WHERE ($1='' OR p.id=$1 OR p.transaction_id=$1 OR t.created_by=$1 OR s.tracking_number=$1 OR t.external_reference=$1 OR t.item_title ILIKE $2 ESCAPE '\\' OR EXISTS(SELECT 1 FROM commerce_order_records o WHERE o.transaction_id=t.id AND o.external_order_id=$1) OR EXISTS(SELECT 1 FROM user_verified_contacts c WHERE c.user_id=t.created_by AND c.email_normalized ILIKE $2 ESCAPE '\\')) AND ($3='' OR p.status=$3 OR ($3='needs_attention' AND EXISTS(SELECT 1 FROM evidence e WHERE e.proof_id=p.id AND (e.validation_status='REJECTED' OR (e.validation_status='PENDING' AND e.created_at<$4::timestamptz-INTERVAL '1 hour')))) OR ($3='shared' AND EXISTS(SELECT 1 FROM proof_access_links l WHERE l.proof_id=p.id)) OR ($3='upload_interrupted' AND EXISTS(SELECT 1 FROM capture_sessions c WHERE c.proof_id=p.id AND c.state='UPLOADING' AND c.expires_at<$4))) AND ($5='' OR t.created_by=$5 OR EXISTS(SELECT 1 FROM proof_participants pp WHERE pp.proof_id=p.id AND pp.user_id=$5)) AND ($6='' OR p.workflow_type=$6) AND ($7='' OR s.carrier=$7) AND ($8='' OR EXISTS(SELECT 1 FROM commerce_order_records o JOIN integration_connections ic ON ic.id=o.connection_id WHERE o.transaction_id=t.id AND ic.provider=$8)) AND (NOT $9::boolean OR (p.created_at >= $10 AND p.created_at<$11)) ORDER BY ${sortOrder(q, { created_at: "p.created_at", finalized_at: "p.finalized_at", status: "p.status", item_title: "t.item_title" }, "created_at")},p.id LIMIT $12 OFFSET $13`,
      [
        search,
        `%${escaped(search)}%`,
        status,
        clock.now().toISOString(),
        owner,
        workflow,
        carrier,
        marketplace,
        useDates,
        range.from,
        range.to,
        p.pageSize,
        (p.page - 1) * p.pageSize,
      ],
    )
  ).rows;
  const s = section(
    "Proofs",
    "Platform-wide Proof lifecycle. Finalized records remain immutable.",
    clock,
    rows.map((r) => ({ ...r, href: href("proofs", r.id) })),
    [
      ["id", "Proof"],
      ["item_title", "Item"],
      ["status", "State"],
      ["workflow_type", "Type"],
      ["user_id", "Owner"],
      ["created_at", "Created"],
      ["finalized_at", "Finalized"],
      ["tracking_number", "Tracking"],
      ["evidence_count", "Committed evidence"],
    ],
    p,
    count(rows),
  );
  return s;
}
export async function evidenceSection(
  deps: AdminReadDeps,
  q: Query,
): Promise<Section> {
  const { db, clock } = deps;
  const range = getRange(clock, q),
    useDates = Boolean(q.period || q.from || q.to);
  const p = pagination(q),
    search = textQuery(q, "q"),
    status = textQuery(q, "status", 30);
  if (
    status &&
    !["PENDING", "COMMITTED", "REJECTED", "DISCARDED"].includes(status)
  )
    throw new DomainError("INVALID_ADMIN_QUERY", "Invalid evidence state", 400);
  const rows = (
    await db.query(
      `SELECT e.id,e.proof_id,e.submitted_by,e.content_type,e.byte_size,e.sha256,e.created_at,e.committed_at,e.validation_status,e.evidence_type,e.capture_origin,e.source,COUNT(*) OVER() AS __total FROM (${EVIDENCE}) e WHERE ($1='' OR e.id=$1 OR e.proof_id=$1 OR e.submitted_by=$1) AND ($2='' OR e.validation_status=$2) AND (NOT $5::boolean OR (e.created_at >= $6 AND e.created_at<$7)) ORDER BY ${sortOrder(q, { created_at: "e.created_at", committed_at: "e.committed_at", byte_size: "e.byte_size", validation_status: "e.validation_status" }, "created_at")},e.id LIMIT $3 OFFSET $4`,
      [
        search,
        status,
        p.pageSize,
        (p.page - 1) * p.pageSize,
        useDates,
        range.from,
        range.to,
      ],
    )
  ).rows;
  const totals = (
    await db.query(
      `SELECT COUNT(*)::integer AS objects,COUNT(*) FILTER(WHERE validation_status='PENDING')::integer AS pending,COUNT(*) FILTER(WHERE validation_status='REJECTED')::integer AS rejected,COALESCE(SUM(byte_size) FILTER(WHERE validation_status='COMMITTED'),0) AS bytes,AVG(byte_size) FILTER(WHERE validation_status='COMMITTED') AS avg_bytes FROM (${EVIDENCE}) e`,
    )
  ).rows[0];
  const s = section(
    "Evidence operations",
    "Root and lifecycle-stage evidence. Cards show total inventory; date filters apply to the record list. Unreferenced storage objects are not included.",
    clock,
    rows.map((r) => ({ ...r, href: href("evidence", r.id) })),
    [
      ["id", "Evidence"],
      ["source", "Source"],
      ["proof_id", "Proof"],
      ["validation_status", "State"],
      ["content_type", "Media"],
      ["byte_size", "Bytes"],
      ["created_at", "Created"],
      ["committed_at", "Committed"],
    ],
    p,
    count(rows),
  );
  s.metrics = [
    metric("objects", "Evidence records", totals.objects),
    metric("pending", "Pending evidence", totals.pending),
    metric("rejected", "Rejected evidence", totals.rejected),
    metric("bytes", "Committed bytes recorded", totals.bytes, null, {
      unit: "bytes",
    }),
    metric("average_bytes", "Average committed size", totals.avg_bytes, null, {
      unit: "bytes",
    }),
  ];
  s.notices = [
    "Integrity checks are available on each Proof. They verify referenced objects without deleting or altering evidence.",
    "Bucket-wide orphan detection and transfer duration are unavailable; no inventory listing permission or complete transfer telemetry is assumed.",
  ];
  return s;
}
export async function integrationsSection(
  deps: AdminReadDeps,
  q: Query,
): Promise<Section> {
  const { db, clock } = deps,
    p = pagination(q);
  if (textQuery(q, "view", 30) === "webhooks") {
    const rows = (
      await db.query(
        `SELECT d.id,d.state,d.attempts,d.last_status,d.next_attempt_at,d.delivered_at,COUNT(*) OVER() AS __total FROM api_webhook_deliveries d WHERE ($1='' OR state=$1) ORDER BY next_attempt_at DESC,id LIMIT $2 OFFSET $3`,
        [textQuery(q, "status", 30), p.pageSize, (p.page - 1) * p.pageSize],
      )
    ).rows;
    return section(
      "Outbound webhook deliveries",
      "Delivery state with guarded retry for exhausted events.",
      clock,
      rows.map((r) => ({ ...r, href: href("webhooks", r.id) })),
      [
        ["id", "Delivery"],
        ["state", "State"],
        ["attempts", "Attempts"],
        ["last_status", "HTTP status"],
        ["next_attempt_at", "Next attempt"],
        ["delivered_at", "Delivered"],
      ],
      p,
      count(rows),
    );
  }
  const rows = (
    await db.query(
      `WITH connections AS (SELECT ca.id,ca.user_id,ca.provider,ca.external_account_name AS account,ca.status,ca.expires_at,ca.updated_at,'account' AS kind FROM connected_accounts ca UNION ALL SELECT ic.id,ic.owner_user_id AS user_id,ic.provider,ic.external_account_reference AS account,ic.status,NULL::timestamptz AS expires_at,ic.updated_at,'connection' AS kind FROM integration_connections ic) SELECT id,user_id,provider,account,status,expires_at,updated_at,kind,COUNT(*) OVER() AS __total FROM connections WHERE ($1='' OR provider=$1) AND ($2='' OR status=$2) AND ($3='' OR id=$3 OR user_id=$3 OR account ILIKE $4 ESCAPE '\\') ORDER BY ${sortOrder(q, { updated_at: "updated_at", provider: "provider", status: "status" }, "updated_at")},id LIMIT $5 OFFSET $6`,
      [
        textQuery(q, "provider", 30),
        textQuery(q, "status", 30),
        textQuery(q, "q"),
        `%${escaped(textQuery(q, "q"))}%`,
        p.pageSize,
        (p.page - 1) * p.pageSize,
      ],
    )
  ).rows;
  const sync = (
    await db.query(
      `SELECT COUNT(*)::integer AS connections,COUNT(*) FILTER(WHERE last_error_code IS NOT NULL)::integer AS failed,MAX(last_succeeded_at) AS last_success FROM commerce_connection_sync_states`,
    )
  ).rows[0];
  const s = section(
    "Integrations",
    "Marketplace, carrier and identity connections. Connection state is separate from external provider uptime.",
    clock,
    rows.map((r) => ({ ...r, href: href("integrations", r.id) })),
    [
      ["provider", "Provider"],
      ["account", "Account"],
      ["user_id", "User"],
      ["kind", "Record"],
      ["status", "Connection"],
      ["expires_at", "Expires"],
      ["updated_at", "Updated"],
    ],
    p,
    count(rows),
  );
  s.metrics = [
    metric("connections", "Commerce sync connections", sync.connections),
    metric("failed", "Connections with last sync error", sync.failed),
  ];
  s.notices = [
    "Request latency and provider-wide 24-hour success rates are unavailable without complete request telemetry.",
    `Last successful commerce sync: ${sync.last_success instanceof Date ? sync.last_success.toISOString() : (sync.last_success ?? "No successful sync recorded")}. Carrier activity is available in the activity trend.`,
  ];
  return s;
}
const ERROR_SOURCES = `SELECT 'evidence'::text AS service,'EVIDENCE_REJECTED'::text AS code,e.created_at AS observed_at,e.submitted_by AS user_id,e.proof_id FROM evidence e WHERE validation_status='REJECTED' UNION ALL SELECT 'commerce' AS service,s.last_error_code AS code,s.updated_at AS observed_at,c.owner_user_id AS user_id,NULL::text AS proof_id FROM commerce_connection_sync_states s JOIN integration_connections c ON c.id=s.connection_id WHERE s.last_error_code IS NOT NULL UNION ALL SELECT 'preservation' AS service,COALESCE(d.error_code,'RECOVERY_DEAD_LETTER') AS code,e.created_at AS observed_at,NULL::text AS user_id,e.proof_id FROM recovery_delivery d JOIN recovery_events e ON e.operation_id=d.operation_id WHERE d.state='DEAD_LETTER' UNION ALL SELECT 'notifications' AS service,'NOTIFICATION_DELIVERY_FAILED' AS code,o.created_at AS observed_at,NULL::text AS user_id,o.proof_id FROM proof_notification_outbox o WHERE o.last_error IS NOT NULL AND o.sent_at IS NULL AND o.cancelled_at IS NULL UNION ALL SELECT 'media' AS service,COALESCE(failure_code,'DERIVATIVE_FAILED') AS code,created_at AS observed_at,created_by_user_id AS user_id,proof_id FROM proof_media_derivatives WHERE status='FAILED' UNION ALL SELECT 'api' AS service,'HTTP_'||status::text AS code,created_at AS observed_at,actor_user_id AS user_id,NULL::text AS proof_id FROM api_request_audit WHERE status>=400`;
export async function errorsSection(
  deps: AdminReadDeps,
  q: Query,
): Promise<Section> {
  const { db, clock } = deps,
    p = pagination(q),
    range = getRange(clock, q);
  const rows = (
    await db.query(
      `WITH failures AS (${ERROR_SOURCES}), grouped AS (SELECT service,CASE WHEN code ~ '^[A-Z][A-Z0-9_.:-]{0,79}$' THEN code ELSE 'OPERATION_FAILED' END AS code,MIN(observed_at) AS first_seen,MAX(observed_at) AS last_seen,COUNT(*)::integer AS occurrences,COUNT(DISTINCT user_id)::integer AS affected_users,COUNT(DISTINCT proof_id)::integer AS affected_proofs FROM failures WHERE observed_at>=$1 AND observed_at<$2 AND ($3='' OR service=$3) GROUP BY 1,2) SELECT g.service,g.code,g.first_seen,g.last_seen,g.occurrences,g.affected_users,g.affected_proofs,COALESCE(t.status,'NEW') AS triage_status,COALESCE(t.version,0) AS triage_version,t.updated_at AS triaged_at,COUNT(*) OVER() AS __total FROM grouped g LEFT JOIN admin_error_triage t ON t.service=g.service AND t.code=g.code WHERE ($4='' OR g.code ILIKE $5 ESCAPE '\\') AND ($8='' OR COALESCE(t.status,'NEW')=$8) ORDER BY ${sortOrder(q, { last_seen: "g.last_seen", first_seen: "g.first_seen", occurrences: "g.occurrences", service: "g.service", triage_status: "triage_status" }, "last_seen")} LIMIT $6 OFFSET $7`,
      [
        range.from,
        range.to,
        textQuery(q, "service", 30),
        textQuery(q, "q"),
        `%${escaped(textQuery(q, "q"))}%`,
        p.pageSize,
        (p.page - 1) * p.pageSize,
        textQuery(q, "status", 20),
      ],
    )
  ).rows;
  const s = section(
    "Error center",
    "Grouped observable failures; current failed work and recorded API errors.",
    clock,
    rows.map((r) => ({ ...r, href: href("errors", `${r.service}:${r.code}`) })),
    [
      ["code", "Error"],
      ["service", "Service"],
      ["triage_status", "Triage"],
      ["occurrences", "Records"],
      ["affected_users", "Users"],
      ["affected_proofs", "Proofs"],
      ["first_seen", "First observed"],
      ["last_seen", "Latest observed"],
    ],
    p,
    count(rows),
  );
  s.notices = [
    "Counts reflect persisted records, not every retry. Triage is an administrative annotation; a resolved label does not prove remediation. Provider messages and payloads are excluded to protect credentials. Frontend exceptions are unavailable unless connected to a telemetry source.",
  ];
  return s;
}
export async function auditSection(
  deps: AdminReadDeps,
  q: Query,
  security = false,
): Promise<Section> {
  const { db, clock } = deps,
    p = pagination(q),
    range = getRange(clock, q);
  const rows = (
    await db.query(
      `SELECT id,actor_id,action,target_type,target_id,reason,created_at,severity,COUNT(*) OVER() AS __total FROM system_admin_audit_events WHERE created_at>=$1 AND created_at<$2 AND ($3='' OR actor_id=$3) AND ($4='' OR action=$4) AND ($5='' OR target_id=$5) ORDER BY ${sortOrder(q, { created_at: "created_at", action: "action", severity: "severity" }, "created_at")},id LIMIT $6 OFFSET $7`,
      [
        range.from,
        range.to,
        textQuery(q, "actorId"),
        textQuery(q, "action", 100),
        textQuery(q, "targetId"),
        p.pageSize,
        (p.page - 1) * p.pageSize,
      ],
    )
  ).rows;
  const s = section(
    security ? "Security & administration" : "Administrative audit",
    "Immutable administrative events with explicit actor and target.",
    clock,
    rows.map((r) => ({
      ...r,
      href: r.target_type === "user" ? href("users", r.target_id) : null,
    })),
    [
      ["created_at", "Timestamp"],
      ["actor_id", "Administrator"],
      ["action", "Action"],
      ["target_type", "Target type"],
      ["target_id", "Target"],
      ["reason", "Reason"],
      ["severity", "Severity"],
    ],
    p,
    count(rows),
  );
  if (security) {
    const r = (
      await db.query(
        `SELECT COUNT(*) FILTER(WHERE status='DISABLED')::integer AS disabled,COUNT(*) FILTER(WHERE sessions_revoked_before IS NOT NULL)::integer AS revoked FROM users`,
      )
    ).rows[0];
    s.metrics = [
      metric("disabled", "Disabled accounts", r.disabled),
      metric("revoked", "Accounts with session cutoff", r.revoked),
      metric("login_failures", "Authentication failures", null, null, {
        note: "Cognito authentication logs are not connected.",
      }),
    ];
    s.notices = [
      "Authentication successes, password resets and failed logins are unavailable without a Cognito log adapter. No risk conclusions are inferred.",
    ];
  }
  return s;
}
export async function billingSection(
  deps: AdminReadDeps,
  q: Query,
): Promise<Section> {
  const { db, clock } = deps,
    p = pagination(q),
    range = getRange(clock, q);
  const rows = (
    await db.query(
      `SELECT provider,environment,user_id,kind,occurred_at,amount_minor,currency,COUNT(*) OVER() AS __total FROM billing_payment_ledger WHERE occurred_at>=$1 AND occurred_at<$2 AND ($3='' OR user_id=$3) ORDER BY ${sortOrder(q, { occurred_at: "occurred_at", amount_minor: "amount_minor", kind: "kind" }, "occurred_at")},subject_reference LIMIT $4 OFFSET $5`,
      [
        range.from,
        range.to,
        textQuery(q, "userId"),
        p.pageSize,
        (p.page - 1) * p.pageSize,
      ],
    )
  ).rows;
  const totals = (
    await db.query(
      `SELECT COALESCE(SUM(amount_minor) FILTER(WHERE kind='payment_settled'),0) AS gross,COALESCE(SUM(amount_minor) FILTER(WHERE kind='refund_settled'),0)-COALESCE(SUM(amount_minor) FILTER(WHERE kind='refund_reversed'),0) AS refunds,COUNT(DISTINCT user_id) FILTER(WHERE kind='payment_settled') AS paying FROM billing_payment_ledger WHERE occurred_at>=$1 AND occurred_at<$2 AND environment='live'`,
      [range.from, range.to],
    )
  ).rows[0];
  const usage = (
    await db.query(
      `SELECT COUNT(*) AS finalized,COUNT(*) FILTER(WHERE charge_eligible) AS metered FROM billing_proof_usage WHERE finalized_at>=$1 AND finalized_at<$2`,
      [range.from, range.to],
    )
  ).rows[0];
  const s = section(
    "Billing & usage",
    "Verified payment ledger and finalized-Proof metering. Monetary metrics include live USD entries only.",
    clock,
    rows.map((r) => ({
      ...r,
      amount: Number(r.amount_minor) / 100,
      href: href("users", r.user_id),
    })),
    [
      ["occurred_at", "Occurred"],
      ["user_id", "User"],
      ["kind", "Entry"],
      ["amount", "USD"],
      ["environment", "Environment"],
      ["provider", "Provider"],
    ],
    p,
    count(rows),
  );
  s.metrics = [
    metric(
      "gross",
      "Settled payments (USD)",
      Number(totals.gross) / 100,
      null,
      { unit: "currency" },
    ),
    metric(
      "refunds",
      "Settled refunds (USD)",
      Number(totals.refunds) / 100,
      null,
      { unit: "currency" },
    ),
    metric(
      "net",
      "Net settled receipts (USD)",
      (Number(totals.gross) - Number(totals.refunds)) / 100,
      null,
      { unit: "currency" },
    ),
    metric("paying", "Paying users", totals.paying),
    metric("usage", "Metered finalized Proofs", usage.finalized),
    metric("eligible", "Charge-eligible Proofs", usage.metered),
  ];
  s.notices = [
    "Prepaid credit purchases and balance are unavailable: current billing uses consented offer allowances. Administrative allowance adjustments are immutable and available on eligible user accounts.",
  ];
  return s;
}
export async function activity(deps: AdminReadDeps, q: Query = {}) {
  const p = pagination(q),
    type = textQuery(q, "type", 80);
  const rows = (
    await deps.db.query(
      `SELECT id,type,created_at,user_id,proof_id FROM (SELECT id,event_type AS type,created_at,actor_user_id AS user_id,proof_id FROM audit_events WHERE event_type IN ('PROOF_CREATED','PROOF_FINALIZED','EVIDENCE_COMMITTED','PARTICIPANT_JOINED','INVITATION_ACCEPTED','PROOF_VIEWED_VIA_ACCESS_LINK','PROOF_ACCESSED','PROOF_ACCESS_LINK_CREATED','SHIPMENT_EVENT_RECORDED') UNION ALL SELECT id,'USER_REGISTERED' AS type,created_at,id AS user_id,NULL::text AS proof_id FROM users UNION ALL SELECT id,'ADMIN_'||action AS type,created_at,actor_id AS user_id,NULL::text AS proof_id FROM system_admin_audit_events) events WHERE ($1='' OR type=$1) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,
      [type, p.pageSize, (p.page - 1) * p.pageSize],
    )
  ).rows;
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    createdAt: r.created_at,
    userId: r.user_id,
    proofId: r.proof_id,
    summary: String(r.type).replace(/_/g, " ").toLowerCase(),
  }));
}
export async function overview(deps: AdminReadDeps, q: Query) {
  const { db, clock } = deps,
    range = getRange(clock, q);
  const metrics = await Promise.all(
    [
      "registrations",
      "active_users",
      "proofs_created",
      "proofs_finalized",
      "evidence_captures",
      "proof_views",
      "marketplace_imports",
      "shared_links",
    ].map((k) => metricCounts(db, k, range)),
  );
  const totals = (
    await db.query(
      `SELECT (SELECT COUNT(*) FROM users WHERE created_at<$2) AS users,(SELECT COUNT(*) FROM users WHERE created_at<$1) AS previous_users,(SELECT COUNT(*) FROM proofs WHERE created_at<$2) AS proofs,(SELECT COUNT(*) FROM proofs WHERE created_at<$1) AS previous_proofs`,
      [range.from, range.to],
    )
  ).rows[0];
  metrics.unshift(
    metric("total_users", "Total users", totals.users, totals.previous_users, {
      href: "/admin/users",
    }),
    metric(
      "total_proofs",
      "Total Proofs",
      totals.proofs,
      totals.previous_proofs,
      { href: "/admin/proofs" },
    ),
  );
  const success = (
    await db.query(
      `SELECT COUNT(*) FILTER(WHERE validation_status='COMMITTED' AND created_at>=$1) AS committed,COUNT(*) FILTER(WHERE validation_status IN ('COMMITTED','REJECTED') AND created_at>=$1) AS terminal,COUNT(*) FILTER(WHERE validation_status='COMMITTED' AND created_at<$1) AS previous_committed,COUNT(*) FILTER(WHERE validation_status IN ('COMMITTED','REJECTED') AND created_at<$1) AS previous_terminal FROM (${EVIDENCE}) e WHERE created_at >= $3 AND created_at<$2`,
      [range.from, range.to, range.previousFrom],
    )
  ).rows[0];
  metrics.push(
    metric(
      "upload_success",
      "Accepted terminal uploads",
      Number(success.terminal)
        ? (Number(success.committed) / Number(success.terminal)) * 100
        : null,
      Number(success.previous_terminal)
        ? (Number(success.previous_committed) /
            Number(success.previous_terminal)) *
            100
        : null,
      {
        unit: "percent",
        note: "Committed / (committed + rejected); pending and unobserved transport failures excluded.",
      },
    ),
  );
  const pending = (
    await db.query(
      `SELECT COUNT(DISTINCT proof_id)::integer AS proofs,COUNT(*)::integer AS objects,MIN(created_at) AS first_seen,MAX(created_at) AS last_seen FROM (${EVIDENCE}) e WHERE validation_status='PENDING' AND created_at<$1::timestamptz-INTERVAL '1 hour'`,
      [clock.now().toISOString()],
    )
  ).rows[0];
  metrics.push(
    metric(
      "attention_proofs",
      "Proofs with stale pending uploads",
      pending.proofs,
      null,
      {
        href: "/admin/proofs?status=needs_attention",
        note: "Pending evidence older than one hour; history cannot reconstruct a prior backlog.",
      },
    ),
  );
  const errors = await errorsSection(deps, { ...q, pageSize: "8" });
  const attention = errors.rows
    .filter((r) => r.service !== "api" || Number(r.occurrences) >= 10)
    .map((r, i) => ({
      id: `${r.service}:${r.code}:${i}`,
      severity: r.service === "preservation" ? "critical" : "warning",
      component: r.service,
      title: r.code,
      count: Number(r.occurrences),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      href: `/admin/errors?service=${encodeURIComponent(String(r.service))}`,
    }));
  if (Number(pending.objects) > 0)
    attention.unshift({
      id: "stale-pending",
      severity: "warning",
      component: "evidence",
      title: "Pending uploads older than one hour",
      count: Number(pending.objects),
      firstSeen:
        pending.first_seen instanceof Date
          ? pending.first_seen.toISOString()
          : String(pending.first_seen),
      lastSeen:
        pending.last_seen instanceof Date
          ? pending.last_seen.toISOString()
          : String(pending.last_seen),
      href: "/admin/evidence?status=PENDING",
    });
  return {
    environment:
      deps.releaseIdentity?.environment ??
      process.env.PACKPROOF_ENVIRONMENT ??
      "development",
    updatedAt: clock.now().toISOString(),
    range,
    metrics: metrics.map((m) => ({
      ...m,
      href:
        m.href ??
        (m.key.includes("user") || m.key === "registrations"
          ? "/admin/users"
          : "/admin/proofs"),
    })),
    attention,
    activity: await activity(deps, { pageSize: "12" }),
    notices: [
      "Overview metrics are cached for 30 seconds. Activity counts measure recorded events. All-time covers the full recorded history.",
    ],
  };
}
export async function search(deps: AdminReadDeps, q: Query) {
  const query = textQuery(q, "q");
  if (query.length < 2) return { results: [] };
  const params = [query, `%${escaped(query)}%`];
  const users = (
    await deps.db.query(
      `SELECT u.id,COALESCE(u.display_name,u.username,u.id) AS title,${EMAIL} AS subtitle FROM users u WHERE u.id=$1 OR u.username ILIKE $2 ESCAPE '\\' OR u.display_name ILIKE $2 ESCAPE '\\' OR EXISTS(SELECT 1 FROM user_verified_contacts c WHERE c.user_id=u.id AND c.email_normalized ILIKE $2 ESCAPE '\\') OR EXISTS(SELECT 1 FROM auth_identities a WHERE a.user_id=u.id AND a.provider_subject=$1) ORDER BY CASE WHEN u.id=$1 THEN 0 ELSE 1 END,u.created_at DESC LIMIT 8`,
      params,
    )
  ).rows;
  const proofs = (
    await deps.db.query(
      `SELECT p.id,COALESCE(t.item_title,p.id) AS title,p.status AS subtitle FROM proofs p JOIN transactions t ON t.id=p.transaction_id LEFT JOIN transaction_shipping s ON s.transaction_id=t.id WHERE p.id=$1 OR p.transaction_id=$1 OR s.tracking_number=$1 OR t.external_reference=$1 OR EXISTS(SELECT 1 FROM commerce_order_records o WHERE o.transaction_id=t.id AND o.external_order_id=$1) ORDER BY p.created_at DESC LIMIT 8`,
      [query],
    )
  ).rows;
  const evidence = (
    await deps.db.query(
      `SELECT id,proof_id,content_type AS subtitle FROM (${EVIDENCE}) e WHERE id=$1 LIMIT 4`,
      [query],
    )
  ).rows;
  return {
    results: [
      ...users.map((r) => ({
        kind: "user",
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        href: href("users", r.id),
      })),
      ...proofs.map((r) => ({
        kind: "proof",
        id: r.id,
        title: r.title,
        subtitle: r.subtitle,
        href: href("proofs", r.id),
      })),
      ...evidence.map((r) => ({
        kind: "evidence",
        id: r.id,
        title: r.id,
        subtitle: r.subtitle,
        href: href("proofs", r.proof_id),
      })),
    ],
  };
}
export async function userDetail(
  deps: AdminReadDeps,
  id: string,
  actorId?: string,
) {
  const { db, clock } = deps;
  const u = (
    await db.query(
      `SELECT u.id,u.username,u.display_name,u.status,u.admin_version AS "adminVersion",u.created_at,u.sessions_revoked_before,${EMAIL} AS email FROM users u WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (!u) throw new DomainError("USER_NOT_FOUND", "User not found", 404);
  const identities = (
    await db.query(
      "SELECT provider,provider_subject,created_at FROM auth_identities WHERE user_id=$1 ORDER BY created_at LIMIT 25",
      [id],
    )
  ).rows;
  const connections = (
    await db.query(
      "SELECT id,provider,external_account_name,status,expires_at,updated_at FROM connected_accounts WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 50",
      [id],
    )
  ).rows;
  const adjustments = (
    await db.query(
      "SELECT delta,reason,actor_id,created_at FROM billing_allowance_adjustments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",
      [id],
    )
  ).rows;
  const evidence = await evidenceSection(deps, { q: id, pageSize: "20" });
  const actions = adminUserActions(
    { id, status: String(u.status), adminVersion: Number(u.adminVersion) },
    actorId,
  );
  const usage = await getAccountUsageSummary(db, clock, id);
  if (!usage.currentOffer) {
    const adjustment = actions.findIndex((a) => a.id === "adjust-allowance");
    if (adjustment >= 0) actions.splice(adjustment, 1);
  }
  const billing = section(
    "Current billing allowance",
    usage.message,
    clock,
    usage.currentOffer
      ? [
          {
            version: usage.currentOffer.version,
            includedFinalizedProofs: usage.currentOffer.includedFinalizedProofs,
            allowanceAdjustments: usage.currentOffer.allowanceAdjustments,
            effectiveAllowance: usage.currentOffer.effectiveAllowance,
            used: usage.currentOffer.used,
            remaining: usage.currentOffer.remaining,
          },
        ]
      : [],
    [
      ["version", "Offer"],
      ["includedFinalizedProofs", "Included"],
      ["allowanceAdjustments", "Adjustments"],
      ["effectiveAllowance", "Effective allowance"],
      ["used", "Used"],
      ["remaining", "Remaining"],
    ],
  );
  return {
    title: String(u.display_name || u.username || u.id),
    subtitle: "Account operations",
    id,
    adminVersion: Number(u.adminVersion),
    status: u.status,
    fields: Object.entries(u)
      .filter(([key]) => key !== "adminVersion")
      .map(([label, value]) => ({
        label: label.replace(/_/g, " "),
        value: value instanceof Date ? value.toISOString() : value,
      })),
    sections: [
      await proofsSection(deps, { userId: id, pageSize: "20" }),
      evidence,
      billing,
      section(
        "Authentication identities",
        "Provider subject IDs; authentication material is never exposed.",
        clock,
        identities,
        [
          ["provider", "Provider"],
          ["provider_subject", "Subject"],
          ["created_at", "Linked"],
        ],
      ),
      section(
        "Connections",
        "Current linked external accounts.",
        clock,
        connections,
        [
          ["provider", "Provider"],
          ["external_account_name", "Account"],
          ["status", "State"],
          ["expires_at", "Expires"],
        ],
      ),
      section(
        "Allowance adjustment ledger",
        "Immutable adjustments against current consented offer allowance.",
        clock,
        adjustments,
        [
          ["created_at", "Date"],
          ["delta", "Change"],
          ["reason", "Reason"],
          ["actor_id", "Administrator"],
        ],
      ),
      await auditSection(deps, { targetId: id, period: "all", pageSize: "20" }),
    ],
    actions,
    notices: [
      "Device version, exact last login and password-reset history are unavailable unless their provider telemetry is connected.",
    ],
  };
}
export async function proofDetail(deps: AdminReadDeps, id: string) {
  const { db, clock } = deps;
  const p = (
    await db.query(
      `SELECT p.id,p.transaction_id,p.status,p.workflow_type,p.created_at,p.finalized_at,p.manifest_id,t.created_by AS owner_user_id,t.item_title,t.external_reference,s.carrier,s.tracking_number FROM proofs p JOIN transactions t ON t.id=p.transaction_id LEFT JOIN transaction_shipping s ON s.transaction_id=t.id WHERE p.id=$1`,
      [id],
    )
  ).rows[0];
  if (!p) throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
  const participants = (
    await db.query(
      "SELECT user_id,role,joined_at FROM proof_participants WHERE proof_id=$1 ORDER BY joined_at LIMIT 100",
      [id],
    )
  ).rows;
  const manifest = (
    await db.query(
      "SELECT id,sha256,created_at,signature_algorithm,signed_at FROM final_manifests WHERE proof_id=$1",
      [id],
    )
  ).rows;
  const attestations = (
    await db.query(
      "SELECT id,attested_by,statement,created_at,related_evidence_id FROM attestations WHERE proof_id=$1 ORDER BY created_at DESC LIMIT 100",
      [id],
    )
  ).rows;
  const audit = (
    await db.query(
      "SELECT id,event_type,actor_user_id,created_at FROM audit_events WHERE proof_id=$1 ORDER BY created_at DESC LIMIT 100",
      [id],
    )
  ).rows;
  const shares = (
    await db.query(
      "SELECT id,scope,created_at,expires_at,revoked_at,last_accessed_at,view_count FROM proof_access_links WHERE proof_id=$1 ORDER BY created_at DESC LIMIT 100",
      [id],
    )
  ).rows;
  const tracking = (
    await db.query(
      "SELECT id,event_type,carrier,provider,source,occurred_at,observed_at FROM shipment_events WHERE proof_id=$1 ORDER BY occurred_at DESC LIMIT 100",
      [id],
    )
  ).rows;
  const storage = (
    await db.query(
      `SELECT id,source,object_key,object_version_id,sha256,byte_size FROM (${EVIDENCE}) e WHERE proof_id=$1 ORDER BY created_at DESC LIMIT 100`,
      [id],
    )
  ).rows;
  return {
    title: String(p.item_title || p.id),
    subtitle: "Immutable Proof lifecycle",
    id,
    fields: Object.entries(p).map(([label, value]) => ({
      label: label.replace(/_/g, " "),
      value: value instanceof Date ? value.toISOString() : value,
    })),
    sections: [
      section(
        "Participants",
        "Authorized transaction participants.",
        clock,
        participants.map((r) => ({ ...r, href: href("users", r.user_id) })),
        [
          ["user_id", "User"],
          ["role", "Role"],
          ["joined_at", "Joined"],
        ],
      ),
      await evidenceSection(deps, { q: id, pageSize: "100" }),
      section(
        "Manifest",
        "Canonical manifest fingerprint; use Integrity Check to verify digest and evidence references.",
        clock,
        manifest,
        [
          ["id", "Manifest"],
          ["sha256", "SHA-256"],
          ["created_at", "Prepared"],
          ["signature_algorithm", "Signature"],
          ["signed_at", "Signed"],
        ],
      ),
      section(
        "Attestations",
        "Immutable recorded statements.",
        clock,
        attestations,
        [
          ["attested_by", "User"],
          ["statement", "Statement"],
          ["related_evidence_id", "Evidence"],
          ["created_at", "Recorded"],
        ],
      ),
      section(
        "Storage references",
        "Read-only identifiers; no temporary access links or credentials.",
        clock,
        storage,
        [
          ["id", "Evidence"],
          ["source", "Source"],
          ["object_key", "Object key"],
          ["object_version_id", "Version"],
          ["sha256", "SHA-256"],
          ["byte_size", "Bytes"],
        ],
      ),
      section(
        "Tracking observations",
        "Append-only shipment observations.",
        clock,
        tracking,
        [
          ["event_type", "Event"],
          ["carrier", "Carrier"],
          ["provider", "Provider"],
          ["source", "Source"],
          ["occurred_at", "Occurred"],
        ],
      ),
      section(
        "Share history",
        "Share metadata only; bearer link tokens are excluded.",
        clock,
        shares,
        [
          ["id", "Share"],
          ["scope", "Scope"],
          ["created_at", "Created"],
          ["revoked_at", "Revoked"],
          ["view_count", "Views"],
          ["last_accessed_at", "Last viewed"],
        ],
      ),
      section(
        "Proof audit",
        "Most recent 100 immutable Proof events; event payloads excluded.",
        clock,
        audit,
        [
          ["event_type", "Event"],
          ["actor_user_id", "Actor"],
          ["created_at", "Date"],
        ],
      ),
    ],
    actions: [
      {
        id: "integrity",
        label: "Run integrity check",
        path: `/admin/proofs/${encodeURIComponent(id)}/integrity`,
        method: "GET",
        risk: "low",
      },
    ],
    notices: [
      "No administration API permits mutation of committed evidence or finalized manifests. Related lists are capped at 100 records; use explorers for full pagination.",
    ],
  };
}
const digestInFlight = new WeakMap<
  ObjectStore,
  Map<string, Promise<Awaited<ReturnType<ObjectStore["digest"]>>>>
>();
function guardedDigest(
  store: ObjectStore,
  key: string,
  version: string | null,
) {
  let pending = digestInFlight.get(store);
  if (!pending) {
    pending = new Map();
    digestInFlight.set(store, pending);
  }
  const identity = `${key}:${version ?? ""}`;
  const existing = pending.get(identity);
  if (existing) return existing;
  if (pending.size >= 4)
    throw new DomainError(
      "ADMIN_DIAGNOSTIC_BUSY",
      "Storage verification capacity is occupied",
      429,
    );
  const current = store
    .digest(key, { versionId: version })
    .finally(() => pending!.delete(identity));
  pending.set(identity, current);
  return current;
}
export async function integrityCheck(deps: AdminReadDeps, id: string) {
  const { db, clock, objectStore } = deps;
  const proof = (
    await db.query<{
      id: string;
      status: string;
      transaction_id: string;
      manifest_id: string | null;
      finalized_at: Date | string | null;
    }>(
      "SELECT id,status,transaction_id,manifest_id,finalized_at FROM proofs WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!proof) throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
  type Check = {
    key: string;
    status: "PASS" | "WARNING" | "FAIL";
    detail: string;
    evidenceId?: string;
  };
  const checks: Check[] = [];
  const manifest = (
    await db.query<{
      id: string;
      canonical_json: string;
      sha256: string;
    }>(
      "SELECT id,canonical_json,sha256 FROM final_manifests WHERE proof_id=$1",
      [id],
    )
  ).rows[0];
  let canonical: Record<string, unknown> | null = null;
  if (manifest) {
    checks.push({
      key: "manifest_digest",
      status:
        sha256Hex(manifest.canonical_json) === manifest.sha256
          ? "PASS"
          : "FAIL",
      detail:
        "SHA-256 of stored canonical manifest compared with its committed digest.",
    });
    try {
      const parsed: unknown = JSON.parse(manifest.canonical_json);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Invalid structure");
      canonical = parsed as Record<string, unknown>;
      checks.push({
        key: "manifest_identity",
        status:
          canonical.proofId === proof.id &&
          canonical.transactionId === proof.transaction_id
            ? "PASS"
            : "FAIL",
        detail:
          "Manifest Proof and transaction identity compared with database references.",
      });
    } catch {
      checks.push({
        key: "manifest_structure",
        status: "FAIL",
        detail: "Stored manifest cannot be parsed.",
      });
    }
    checks.push({
      key: "manifest_binding",
      status:
        proof.manifest_id === manifest.id
          ? "PASS"
          : proof.status === "FINALIZED"
            ? "FAIL"
            : "WARNING",
      detail: "Manifest identifier compared with the Proof reference.",
    });
  } else
    checks.push({
      key: "manifest",
      status: proof.status === "FINALIZED" ? "FAIL" : "WARNING",
      detail:
        proof.status === "FINALIZED"
          ? "Finalized Proof has no canonical manifest."
          : "This Proof has not prepared a final manifest.",
    });
  checks.push({
    key: "finalized_state",
    status:
      proof.status !== "FINALIZED"
        ? "WARNING"
        : proof.finalized_at && manifest && proof.manifest_id === manifest.id
          ? "PASS"
          : "FAIL",
    detail:
      proof.status === "FINALIZED"
        ? "Finalized state, timestamp and manifest linkage checked."
        : "Proof is still in progress.",
  });
  const all = (
    await db.query<{
      id: string;
      source: string;
      sha256: string | null;
      byte_size: string | number | null;
      object_key: string;
      object_version_id: string | null;
      validation_status: string;
    }>(
      `SELECT id,source,sha256,byte_size,object_key,object_version_id,validation_status FROM (${EVIDENCE}) e WHERE proof_id=$1 AND validation_status='COMMITTED' ORDER BY id LIMIT 101`,
      [id],
    )
  ).rows;
  if (!all.length)
    checks.push({
      key: "evidence",
      status: proof.status === "FINALIZED" ? "FAIL" : "WARNING",
      detail: "No committed evidence was found.",
    });
  if (canonical) {
    const listed = Array.isArray(canonical.evidence)
      ? (canonical.evidence as Array<Record<string, unknown>>)
      : null;
    const root = all.filter((e) => e.source === "ROOT");
    const valid =
      listed &&
      listed.length === root.length &&
      root.every((e) =>
        listed.some(
          (m) =>
            m.evidenceId === e.id &&
            m.sha256 === e.sha256 &&
            m.objectKey === e.object_key &&
            (m.objectVersionId ?? null) === (e.object_version_id ?? null) &&
            Number(m.byteSize) === Number(e.byte_size),
        ),
      );
    checks.push({
      key: "manifest_evidence",
      status: all.length > 100 ? "WARNING" : valid ? "PASS" : "FAIL",
      detail:
        all.length > 100
          ? "Manifest reference comparison exceeds bounded check limit."
          : "Root evidence IDs, hashes, sizes and object references compared with the immutable manifest.",
    });
  }
  let bytes = 0,
    checked = 0;
  const deadline = Date.now() + 20000;
  for (const e of all) {
    if (
      checked >= 25 ||
      bytes + Number(e.byte_size ?? 0) > 500000000 ||
      Date.now() > deadline
    ) {
      checks.push({
        key: "limit",
        status: "WARNING",
        detail:
          "Diagnostic budget reached (25 objects, 500 MB or 20 seconds). Remaining objects were not verified.",
      });
      break;
    }
    checked++;
    bytes += Number(e.byte_size ?? 0);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const digest = await Promise.race([
        guardedDigest(objectStore, e.object_key, e.object_version_id),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timeout")),
            Math.max(1, Math.min(8000, deadline - Date.now())),
          );
        }),
      ]);
      checks.push({
        key: "evidence_object",
        evidenceId: e.id,
        status:
          digest &&
          digest.sha256 === e.sha256 &&
          digest.byteSize === Number(e.byte_size)
            ? "PASS"
            : "FAIL",
        detail: digest
          ? "Stored object digest and byte length compared with committed evidence."
          : "Referenced evidence object was not found.",
      });
    } catch (error) {
      const corrupt =
        error instanceof DomainError &&
        [
          "EVIDENCE_OBJECT_INTEGRITY_FAILURE",
          "EVIDENCE_OBJECT_INCOMPLETE",
        ].includes(error.code);
      checks.push({
        key: "evidence_object",
        evidenceId: e.id,
        status: corrupt ? "FAIL" : "WARNING",
        detail: corrupt
          ? "Stored object failed its integrity or completeness check."
          : "Storage could not be verified within the request budget.",
      });
      if (!corrupt) break;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    proofId: id,
    checkedAt: clock.now().toISOString(),
    status: checks.some((c) => c.status === "FAIL")
      ? "FAIL"
      : checks.some((c) => c.status === "WARNING")
        ? "WARNING"
        : "PASS",
    checks,
    objectsChecked: checked,
    bytesChecked: bytes,
    readOnly: true,
    scope:
      "Stored root manifest and referenced root/stage objects. Does not attest camera origin, event truth, or independently verify signing key trust.",
  };
}
export async function integrationDetail(deps: AdminReadDeps, id: string) {
  const { db, clock } = deps;
  const c = (
    await db.query<AdminIntegrationState & Record<string, unknown>>(
      "SELECT id,owner_user_id,provider,status,auto_sync_enabled,created_at,updated_at FROM integration_connections WHERE id=$1",
      [id],
    )
  ).rows[0];
  const account = c
    ? null
    : (
        await db.query(
          "SELECT id,user_id,provider,external_account_name,status,expires_at,created_at,updated_at FROM connected_accounts WHERE id=$1",
          [id],
        )
      ).rows[0];
  if (!c && !account)
    throw new DomainError("INTEGRATION_NOT_FOUND", "Connection not found", 404);
  const row = c ?? account!;
  const sync = c
    ? (
        await db.query<AdminIntegrationSyncState & Record<string, unknown>>(
          "SELECT run_status,attempt_count,last_error_retryable,lease_expires_at,updated_at,last_error_code,next_run_at,last_attempted_at,last_succeeded_at FROM commerce_connection_sync_states WHERE connection_id=$1",
          [id],
        )
      ).rows[0]
    : null;
  const events = account
    ? (
        await db.query(
          "SELECT id,event_type,actor_user_id,created_at FROM account_audit_events WHERE connected_account_id=$1 ORDER BY created_at DESC LIMIT 100",
          [id],
        )
      ).rows
    : [];
  const safeSync = sync
    ? {
        run_status: sync.run_status,
        attempt_count: sync.attempt_count,
        last_error_retryable: sync.last_error_retryable,
        updated_at: sync.updated_at,
        last_error_code: sync.last_error_code
          ? safeErrorCode(sync.last_error_code)
          : null,
        next_run_at: sync.next_run_at ?? null,
        last_attempted_at: sync.last_attempted_at ?? null,
        last_succeeded_at: sync.last_succeeded_at ?? null,
      }
    : null;
  return {
    id,
    title: `${row.provider} connection`,
    subtitle: String(id),
    fields: Object.entries(row).map(([label, value]) => ({
      label: label.replace(/_/g, " "),
      value: value instanceof Date ? value.toISOString() : value,
    })),
    sections: [
      section(
        "Commerce sync",
        "Safe operational metadata; provider cursors and credentials are excluded.",
        clock,
        safeSync ? [safeSync] : [],
        [
          ["run_status", "State"],
          ["attempt_count", "Attempts"],
          ["last_error_code", "Last error"],
          ["last_attempted_at", "Attempted"],
          ["last_succeeded_at", "Succeeded"],
          ["next_run_at", "Next run"],
        ],
      ),
      section(
        "Account connection history",
        "Immutable account events.",
        clock,
        events,
        [
          ["event_type", "Event"],
          ["actor_user_id", "Actor"],
          ["created_at", "Date"],
        ],
      ),
      await auditSection(deps, { targetId: id, period: "all", pageSize: "20" }),
    ],
    actions: c ? adminIntegrationActions(c, sync, clock.now()) : [],
    notices: [
      "Disabling affects processing in PackProof; it does not claim to revoke credentials at the provider. Reconnecting requires the account owner’s OAuth flow.",
    ],
  };
}
export async function webhookDetail(deps: AdminReadDeps, id: string) {
  const row = (
    await deps.db.query<AdminWebhookDeliveryState & Record<string, unknown>>(
      "SELECT d.id,d.state,d.attempts,d.next_attempt_at,d.last_status,d.delivered_at,e.proof_id,w.revoked_at FROM api_webhook_deliveries d JOIN api_webhooks w ON w.id=d.webhook_id JOIN proof_outbox e ON e.id=d.event_id WHERE d.id=$1",
      [id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      "WEBHOOK_NOT_FOUND",
      "Webhook delivery not found",
      404,
    );
  return {
    id,
    title: "Webhook delivery",
    subtitle: id,
    fields: Object.entries(row).map(([label, value]) => ({
      label: label.replace(/_/g, " "),
      value: value instanceof Date ? value.toISOString() : value,
    })),
    sections: [
      await auditSection(deps, { targetId: id, period: "all", pageSize: "20" }),
    ],
    actions: adminWebhookDeliveryActions(row, deps.clock.now()),
    notices: [
      "Retry reschedules the existing immutable event. URLs, signing secrets and payloads are excluded.",
    ],
  };
}
export async function evidenceDetail(deps: AdminReadDeps, id: string) {
  const e = (
    await deps.db.query(
      `SELECT id,proof_id,submitted_by,content_type,byte_size,sha256,created_at,committed_at,validation_status,evidence_type,capture_origin,capture_session_id,object_key,object_version_id,source FROM (${EVIDENCE}) e WHERE id=$1 LIMIT 1`,
      [id],
    )
  ).rows[0];
  if (!e)
    throw new DomainError("EVIDENCE_NOT_FOUND", "Evidence not found", 404);
  return {
    id,
    title: "Evidence record",
    subtitle: id,
    fields: Object.entries(e).map(([label, value]) => ({
      label: label.replace(/_/g, " "),
      value: value instanceof Date ? value.toISOString() : value,
    })),
    sections: [],
    actions: [
      {
        id: "integrity",
        label: "Check Proof integrity",
        method: "GET",
        path: `/admin/proofs/${encodeURIComponent(String(e.proof_id))}/integrity`,
        risk: "low",
      },
    ],
    notices: [
      "Read-only metadata; original media and committed hashes cannot be edited.",
    ],
  };
}
export async function errorDetail(deps: AdminReadDeps, id: string) {
  const separator = id.indexOf(":");
  const service = id.slice(0, separator),
    code = id.slice(separator + 1);
  if (
    separator < 1 ||
    ![
      "evidence",
      "commerce",
      "preservation",
      "notifications",
      "media",
      "api",
    ].includes(service) ||
    !/^[A-Z][A-Z0-9_.:-]{0,79}$/.test(code)
  )
    throw new DomainError("INVALID_ADMIN_QUERY", "Invalid error group", 400);
  const result = await errorsSection(deps, { service, q: code, period: "all" });
  const row = result.rows.find((r) => r.code === code);
  if (!row)
    throw new DomainError("ERROR_NOT_FOUND", "Error group not found", 404);
  const occurrences = (
    await deps.db.query(
      `SELECT observed_at,user_id,proof_id FROM (${ERROR_SOURCES}) e WHERE service=$1 AND (CASE WHEN code ~ '^[A-Z][A-Z0-9_.:-]{0,79}$' THEN code ELSE 'OPERATION_FAILED' END)=$2 ORDER BY observed_at DESC LIMIT 100`,
      [service, code],
    )
  ).rows;
  return {
    id,
    title: code,
    subtitle: service,
    fields: Object.entries(row)
      .filter(([key]) => key !== "href")
      .map(([label, value]) => ({ label: label.replace(/_/g, " "), value })),
    sections: [
      section(
        "Recent affected records",
        "Up to 100 persisted failures. Counts are not a complete request log.",
        deps.clock,
        occurrences.map((r) => ({
          ...r,
          href: r.proof_id
            ? href("proofs", r.proof_id)
            : r.user_id
              ? href("users", r.user_id)
              : null,
        })),
        [
          ["observed_at", "Observed"],
          ["user_id", "User"],
          ["proof_id", "Proof"],
        ],
      ),
      await auditSection(deps, {
        targetId: `${service}:${code}`,
        period: "all",
        pageSize: "20",
      }),
    ],
    actions: adminErrorActions({
      service,
      code,
      status: String(row.triage_status) as
        | "NEW"
        | "INVESTIGATING"
        | "RESOLVED"
        | "IGNORED",
      version: Number(row.triage_version),
    }),
    notices: [
      "Triage records investigation status and never mutates error source history. Recurrence remains visible even after a resolved annotation. Raw logs are excluded to prevent secret disclosure.",
    ],
  };
}
