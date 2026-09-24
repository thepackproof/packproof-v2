import { performance } from "node:perf_hooks";
import type { Clock } from "../clock.js";
import type { Database, QueryResult } from "../db/database.js";
import type { ObjectStore } from "../s3/object-store.js";
import { awsTelemetry, type AwsTelemetryOptions, type AwsTelemetryResult } from "./aws-telemetry.js";

interface InfrastructureDependencies {
  db: Database;
  clock: Clock;
  objectStore: ObjectStore;
  adminAwsTelemetry?: AwsTelemetryOptions;
  config?: {
    authMode?: "dev" | "cognito";
    objectStore?: "local" | "s3";
    cognitoUserPoolId?: string;
    cognitoClientId?: string;
  };
}

export interface PlatformHealthItem {
  key: string;
  label: string;
  status: "healthy" | "warning" | "unavailable";
  detail: string;
  checkedAt: string;
}

interface InfrastructureMetric {
  key: string;
  label: string;
  value: number | null;
  previous: null;
  unit?: string;
  status: "available" | "unavailable";
  note?: string;
}

interface InfrastructureSection {
  title: string;
  description: string;
  updatedAt: string;
  metrics: InfrastructureMetric[];
  columns: { key: string; label: string }[];
  rows: Record<string, string | number | boolean | null>[];
  pagination: { page: number; pageSize: number; total: number };
  notices: string[];
}

interface WorkerRow {
  worker_name: string;
  heartbeat_at: Date | string;
  last_success_at: Date | string | null;
  state: string;
}

interface SampleObject {
  object_key: string;
  object_version_id: string | null;
  byte_size: number | string | null;
}

interface Snapshot {
  checkedAt: string;
  database: PlatformHealthItem;
  storage: PlatformHealthItem;
  workers: PlatformHealthItem;
  workerItems: PlatformHealthItem[];
  databaseLatency: number | null;
  storageLatency: number | null;
  workersAvailable: boolean;
  workersTruncated: boolean;
}

const CACHE_MS = 30_000;
const QUERY_TIMEOUT_MS = 4_000;
const HEAD_TIMEOUT_MS = 3_000;
const MAX_WORKERS = 100;
const snapshots = new WeakMap<Database, WeakMap<ObjectStore, { expiresAt: number; pending: Promise<Snapshot> }>>();
const awsSnapshots = new WeakMap<Database, WeakMap<object, { expiresAt: number; pending: Promise<AwsTelemetryResult> }>>();
const defaultAwsOptions = {};
// An adapter without cancellation must not accumulate concurrent HEAD requests if it hangs.
const headInFlight = new WeakMap<ObjectStore, Promise<unknown>>();

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("ADMIN_PROBE_TIMEOUT")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A UI deadline alone cannot cancel SQL. Also bound the server-side statement. */
function query<T>(db: Database, sql: string): Promise<QueryResult<T>> {
  return within(db.transaction(async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '2000ms'");
    return tx.query<T>(sql);
  }), QUERY_TIMEOUT_MS);
}

function health(key: string, label: string, status: PlatformHealthItem["status"], detail: string, checkedAt: string): PlatformHealthItem {
  return { key, label, status, detail, checkedAt };
}

function milliseconds(value: Date | string | null): number | null {
  if (!value) return null;
  const result = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function workerItem(worker: WorkerRow, now: Date, checkedAt: string): PlatformHealthItem {
  const heartbeat = milliseconds(worker.heartbeat_at);
  const lastSuccess = milliseconds(worker.last_success_at);
  // The housekeeping task intentionally runs once per hour; normal jobs run at least once per minute.
  const staleAfter = worker.worker_name === "operational-cleanup" ? 3 * 3_600_000 : 5 * 60_000;
  const label = /^[a-z0-9-]{1,80}$/.test(worker.worker_name)
    ? worker.worker_name.replaceAll("-", " ") : "Background worker";
  if (heartbeat === null || heartbeat > now.getTime() + 60_000) {
    return health(`worker:${label}`, label, "warning", "Heartbeat timestamp is missing or inconsistent with the server clock.", checkedAt);
  }
  if (now.getTime() - heartbeat > staleAfter) {
    return health(`worker:${label}`, label, "warning", `Latest heartbeat is stale: ${new Date(heartbeat).toISOString()}.`, checkedAt);
  }
  if (worker.state === "ERROR") {
    return health(`worker:${label}`, label, "warning", "The most recent worker instance reported an error.", checkedAt);
  }
  if (!["RUNNING", "IDLE"].includes(worker.state) || lastSuccess === null || lastSuccess > now.getTime() + 60_000 || now.getTime() - lastSuccess > staleAfter) {
    return health(`worker:${label}`, label, "warning", "A recent heartbeat exists; a recent successful run has not been confirmed.", checkedAt);
  }
  return health(`worker:${label}`, label, "healthy", `Recent heartbeat and successful run; latest heartbeat ${new Date(heartbeat).toISOString()}.`, checkedAt);
}

async function collect(deps: InfrastructureDependencies): Promise<Snapshot> {
  const now = deps.clock.now();
  const checkedAt = now.toISOString();
  const databaseStarted = performance.now();
  const databaseProbe = query<{ connected: number }>(deps.db, "SELECT 1 AS connected")
    .then((result) => {
      if (result.rows[0]?.connected !== 1) throw new Error("ADMIN_DATABASE_PROBE_FAILED");
      return { item: health("database", "PostgreSQL", "healthy", "A bounded database query completed successfully.", checkedAt), latency: Math.round(performance.now() - databaseStarted) };
    }).catch(() => ({ item: health("database", "PostgreSQL", "unavailable", "The database connectivity probe failed or timed out.", checkedAt), latency: null }));

  const workersProbe = query<WorkerRow>(deps.db, `
    SELECT DISTINCT ON (worker_name) worker_name, heartbeat_at, last_success_at, state
    FROM operational_worker_heartbeats
    ORDER BY worker_name, heartbeat_at DESC, instance_id
    LIMIT ${MAX_WORKERS + 1}`)
    .then((result) => ({ available: true, rows: result.rows }))
    .catch(() => ({ available: false, rows: [] as WorkerRow[] }));

  const storageProbe = (async (): Promise<{ item: PlatformHealthItem; latency: number | null }> => {
    if (!deps.objectStore.head) return { item: health("storage", "Evidence storage", "unavailable", "This storage adapter does not support a read-only metadata probe.", checkedAt), latency: null };
    try {
      const sample = (await query<SampleObject>(deps.db, `
        SELECT object_key, object_version_id, byte_size FROM evidence
        WHERE validation_status = 'COMMITTED' ORDER BY id DESC LIMIT 1`)).rows[0];
      if (!sample) return { item: health("storage", "Evidence storage", "unavailable", "No committed evidence object is available for a read-only storage probe.", checkedAt), latency: null };
      if (headInFlight.has(deps.objectStore)) return { item: health("storage", "Evidence storage", "unavailable", "The previous storage probe is still pending.", checkedAt), latency: null };
      const started = performance.now();
      const pending = deps.objectStore.head(sample.object_key, { versionId: sample.object_version_id });
      headInFlight.set(deps.objectStore, pending);
      // Both settlement callbacks consume errors; no detached rejecting promise is created.
      void pending.then(() => headInFlight.delete(deps.objectStore), () => headInFlight.delete(deps.objectStore));
      const metadata = await within(pending, HEAD_TIMEOUT_MS);
      const latency = Math.round(performance.now() - started);
      if (!metadata) return { item: health("storage", "Evidence storage", "warning", "The sampled committed object was not found. Investigate storage and retention state.", checkedAt), latency };
      if (sample.byte_size !== null && Number(sample.byte_size) !== metadata.byteSize) return { item: health("storage", "Evidence storage", "warning", "The sampled object size differs from the committed record.", checkedAt), latency };
      return { item: health("storage", "Evidence storage", "healthy", "Metadata for one committed evidence object is readable. This does not verify all objects, hashes, or write access.", checkedAt), latency };
    } catch {
      return { item: health("storage", "Evidence storage", "unavailable", "The read-only storage probe failed or timed out.", checkedAt), latency: null };
    }
  })();

  const [database, workers, storage] = await Promise.all([databaseProbe, workersProbe, storageProbe]);
  const workerItems = workers.rows.slice(0, MAX_WORKERS).map((worker) => workerItem(worker, now, checkedAt));
  const missingCore = ["usage-reconciliation", "operational-cleanup"].filter((name) => !workers.rows.some((worker) => worker.worker_name === name));
  const warnings = workerItems.filter((item) => item.status !== "healthy").length;
  const workersItem = !workers.available
    ? health("workers", "Background workers", "unavailable", "Worker heartbeat records could not be read.", checkedAt)
    : workerItems.length === 0
      ? health("workers", "Background workers", "unavailable", "No worker heartbeat has been recorded; worker health is unverified.", checkedAt)
      : health("workers", "Background workers", warnings || missingCore.length ? "warning" : "healthy",
        `${workerItems.length} observed worker groups; ${warnings} need attention.${missingCore.length ? ` ${missingCore.length} core worker groups have no recorded heartbeat.` : ""} Uses the latest instance per group; optional worker coverage is not verified.`, checkedAt);
  return { checkedAt, database: database.item, databaseLatency: database.latency, storage: storage.item,
    storageLatency: storage.latency, workers: workersItem, workerItems, workersAvailable: workers.available,
    workersTruncated: workers.rows.length > MAX_WORKERS };
}

function snapshot(deps: InfrastructureDependencies): Promise<Snapshot> {
  let byStore = snapshots.get(deps.db);
  if (!byStore) { byStore = new WeakMap(); snapshots.set(deps.db, byStore); }
  const cached = byStore.get(deps.objectStore);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const pending = collect(deps);
  byStore.set(deps.objectStore, { pending, expiresAt: Date.now() + CACHE_MS });
  return pending;
}

function telemetrySnapshot(deps: InfrastructureDependencies): Promise<AwsTelemetryResult> {
  let byOptions = awsSnapshots.get(deps.db);
  if (!byOptions) { byOptions = new WeakMap(); awsSnapshots.set(deps.db, byOptions); }
  const options = deps.adminAwsTelemetry ?? defaultAwsOptions;
  const cached = byOptions.get(options);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  const pending = within(awsTelemetry({ ...deps.adminAwsTelemetry, clock: deps.clock }), 5_000)
    .catch((): AwsTelemetryResult => ({
      checkedAt: deps.clock.now().toISOString(),
      metrics: [],
      services: [health("aws-telemetry", "AWS metrics", "unavailable", "The configured AWS metrics source did not complete. Local health probes remain available.", deps.clock.now().toISOString())],
      notices: ["AWS metrics are temporarily unavailable; no cached values or zero usage are inferred."],
    }));
  byOptions.set(options, { pending, expiresAt: Date.now() + CACHE_MS });
  return pending;
}

function authentication(deps: InfrastructureDependencies, checkedAt: string): PlatformHealthItem {
  if (deps.config?.authMode === "dev") return health("authentication", "Authentication", "warning", "Development authentication is configured.", checkedAt);
  const configured = deps.config?.authMode === "cognito" && !!deps.config.cognitoUserPoolId && !!deps.config.cognitoClientId;
  return health("authentication", "Authentication", "unavailable", configured
    ? "Cognito configuration is present; live provider health and sign-in have not been probed."
    : "A live authentication provider probe is not connected; configuration is not verified.", checkedAt);
}

export async function platformHealth(deps: InfrastructureDependencies): Promise<PlatformHealthItem[]> {
  const state = await snapshot(deps);
  return [state.database, state.storage, state.workers, authentication(deps, state.checkedAt)];
}

function metric(key: string, label: string, value: number | null, note: string, unit?: string): InfrastructureMetric {
  return { key, label, value, previous: null, status: value === null ? "unavailable" : "available", note, ...(unit ? { unit } : {}) };
}

function integer(value: unknown, fallback: number, maximum: number): number {
  const parsed = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

export async function infrastructureSection(deps: InfrastructureDependencies, input?: { page?: unknown; pageSize?: unknown }): Promise<InfrastructureSection> {
  const [state, telemetry] = await Promise.all([snapshot(deps), telemetrySnapshot(deps)]);
  const items = [state.database, state.storage, state.workers, authentication(deps, state.checkedAt), ...state.workerItems, ...telemetry.services];
  const page = integer(input?.page, 1, 10_000);
  const pageSize = integer(input?.pageSize, 25, 100);
  return {
    title: "Infrastructure",
    description: "Observed database, storage, and worker health with explicit telemetry coverage.",
    updatedAt: state.checkedAt,
    metrics: [
      metric("databaseLatency", "Database probe", state.databaseLatency, "Single connectivity query including connection acquisition; not application p95 latency.", "ms"),
      metric("storageLatency", "Storage metadata probe", state.storageLatency, "A single committed object; no media bytes are downloaded.", "ms"),
      metric("healthyWorkers", "Healthy worker groups", state.workersAvailable ? state.workerItems.filter((item) => item.status === "healthy").length : null, "Latest instance heartbeat and recent successful run for each observed worker group."),
      metric("workerWarnings", "Worker groups needing attention", state.workersAvailable ? state.workerItems.filter((item) => item.status !== "healthy").length : null, "Recorded groups with stale heartbeats, errors, or no recent successful run; missing groups appear in the health detail."),
      ...telemetry.metrics,
    ],
    columns: [{ key: "service", label: "Service" }, { key: "status", label: "Status" }, { key: "detail", label: "Observation" }, { key: "checkedAt", label: "Checked at" }],
    rows: items.slice((page - 1) * pageSize, page * pageSize).map((item) => ({ id: item.key, service: item.label, status: item.status, detail: item.detail, checkedAt: item.checkedAt })),
    pagination: { page, pageSize, total: items.length },
    notices: [
      "Health probes are cached for 30 seconds. The timestamp shows when this snapshot was collected.",
      "Storage probes read object metadata only and do not establish evidence integrity or write permissions.",
      "Unavailable values are not zero usage or confirmed healthy services. AWS observations carry their own collection windows and timestamps.",
      ...telemetry.notices,
      ...(state.workersTruncated ? ["Worker results are limited to 100 groups; the health summary is partial."] : []),
    ],
  };
}
