import {
  CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand,
  type DescribeAlarmsOutput, type GetMetricDataOutput, type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import {
  CostExplorerClient, GetCostAndUsageCommand, type GetCostAndUsageCommandOutput,
} from "@aws-sdk/client-cost-explorer";
import { systemClock, type Clock } from "../clock.js";

export interface AwsTelemetryMetric {
  key: string;
  label: string;
  value: number | null;
  previous: null;
  unit?: string;
  status: "available" | "unavailable";
  note?: string;
}

export interface AwsTelemetryResult {
  checkedAt: string;
  metrics: AwsTelemetryMetric[];
  services: Array<{
    key: string;
    label: string;
    status: "healthy" | "warning" | "unavailable";
    detail: string;
    checkedAt: string;
  }>;
  notices: string[];
}

export interface AwsTelemetryOptions {
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  cloudWatchClient?: {
    send(command: GetMetricDataCommand | DescribeAlarmsCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
  };
  costExplorerClient?: {
    send(command: GetCostAndUsageCommand, options: { abortSignal: AbortSignal }): Promise<unknown>;
  };
}

type ServiceKey = "api-telemetry" | "ecs" | "rds" | "s3-capacity" | "cloudfront";
interface MetricSpec {
  key: string;
  label: string;
  service: ServiceKey;
  name: string;
  stat: string;
  unit: string;
  factor?: number;
  explanation?: string;
}
interface Resource {
  configured: boolean;
  namespace: string;
  dimensions: Array<{ Name: string; Value: string }>;
}
interface Point { value: number; at: Date }
const DEADLINE_MS = 4_000;
const DAY_MS = 86_400_000;
const PERIOD_MS = 300_000;
const COST_CACHE_MS = 6 * 3_600_000;
const clients = new Map<string, CloudWatchClient>();
let defaultCostClient: CostExplorerClient | undefined;
const costCache = new WeakMap<object, Map<string, { expiresAt: number; pending: Promise<CostObservation> }>>();
const serviceLabels: Record<ServiceKey, string> = {
  "api-telemetry": "API traffic and errors", ecs: "ECS / Fargate", rds: "Database capacity",
  "s3-capacity": "S3 capacity", cloudfront: "CloudFront",
};

// Only these fixed metrics can be requested. There is no resource discovery, metric search,
// arbitrary expression, endpoint override, or caller-provided AWS query in this adapter.
// AWS definitions: https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html
const specs: MetricSpec[] = [
  { key: "apiLatencyP95", label: "API target latency p95", service: "api-telemetry", name: "TargetResponseTime", stat: "p95", unit: "ms", factor: 1000, explanation: "ALB target response-header latency; excludes client/network time." },
  { key: "apiRequests", label: "API routed requests", service: "api-telemetry", name: "RequestCount", stat: "Sum", unit: "requests", explanation: "Requests for which the ALB selected a target; excludes earlier rejections." },
  { key: "apiTarget4xx", label: "API target 4xx responses", service: "api-telemetry", name: "HTTPCode_Target_4XX_Count", stat: "Sum", unit: "responses" },
  { key: "apiTarget5xx", label: "API target 5xx responses", service: "api-telemetry", name: "HTTPCode_Target_5XX_Count", stat: "Sum", unit: "responses" },
  { key: "apiLoadBalancer4xx", label: "Load balancer 4xx responses", service: "api-telemetry", name: "HTTPCode_ELB_4XX_Count", stat: "Sum", unit: "responses" },
  { key: "apiLoadBalancer5xx", label: "Load balancer 5xx responses", service: "api-telemetry", name: "HTTPCode_ELB_5XX_Count", stat: "Sum", unit: "responses" },
  { key: "ecsCpu", label: "ECS service CPU", service: "ecs", name: "CPUUtilization", stat: "Average", unit: "%" },
  { key: "ecsMemory", label: "ECS service memory", service: "ecs", name: "MemoryUtilization", stat: "Average", unit: "%" },
  { key: "rdsCpu", label: "RDS CPU", service: "rds", name: "CPUUtilization", stat: "Average", unit: "%" },
  { key: "rdsConnections", label: "RDS connections", service: "rds", name: "DatabaseConnections", stat: "Average", unit: "connections" },
  { key: "rdsFreeStorage", label: "RDS free storage", service: "rds", name: "FreeStorageSpace", stat: "Average", unit: "bytes" },
  { key: "s3BucketBytes", label: "S3 Standard storage", service: "s3-capacity", name: "BucketSizeBytes", stat: "Average", unit: "bytes", explanation: "StandardStorage only; other storage classes and their overhead are excluded." },
  { key: "s3ObjectCount", label: "S3 object count", service: "s3-capacity", name: "NumberOfObjects", stat: "Average", unit: "objects", explanation: "AllStorageTypes; includes versions, delete markers and incomplete multipart parts for general purpose buckets." },
  { key: "cloudFrontRequests", label: "CloudFront requests", service: "cloudfront", name: "Requests", stat: "Sum", unit: "requests" },
  { key: "cloudFront4xxRate", label: "CloudFront 4xx rate", service: "cloudfront", name: "4xxErrorRate", stat: "Average", unit: "%" },
  { key: "cloudFront5xxRate", label: "CloudFront 5xx rate", service: "cloudfront", name: "5xxErrorRate", stat: "Average", unit: "%" },
  { key: "cloudFrontBytesDownloaded", label: "CloudFront bytes downloaded", service: "cloudfront", name: "BytesDownloaded", stat: "Sum", unit: "bytes" },
];
const rateSpecs = [
  { key: "apiTarget4xxRate", label: "API target 4xx rate", service: "api-telemetry" as const, unit: "%", numerator: "apiTarget4xx" },
  { key: "apiTarget5xxRate", label: "API target 5xx rate", service: "api-telemetry" as const, unit: "%", numerator: "apiTarget5xx" },
];

function configured(env: NodeJS.ProcessEnv, key: string, pattern: RegExp): string | undefined {
  const value = env[`PACKPROOF_ADMIN_${key}`]?.trim();
  return value && pattern.test(value) ? value : undefined;
}

function resources(env: NodeJS.ProcessEnv): Record<ServiceKey, Resource> {
  const alb = configured(env, "ALB_DIMENSION", /^app\/[A-Za-z0-9-]{1,32}\/[a-f0-9]{16}$/);
  const cluster = configured(env, "ECS_CLUSTER", /^[A-Za-z0-9_-]{1,255}$/);
  const service = configured(env, "ECS_SERVICE", /^[A-Za-z0-9_-]{1,255}$/);
  const database = configured(env, "RDS_INSTANCE", /^[A-Za-z][A-Za-z0-9-]{0,62}$/);
  const bucket = configured(env, "S3_BUCKET", /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
  const distribution = configured(env, "CLOUDFRONT_DISTRIBUTION", /^[A-Z0-9]{1,32}$/);
  const resource = (namespace: string, values: Record<string, string | undefined>): Resource => ({
    configured: Object.values(values).every(Boolean), namespace,
    dimensions: Object.entries(values).filter((entry): entry is [string, string] => !!entry[1]).map(([Name, Value]) => ({ Name, Value })),
  });
  return {
    "api-telemetry": resource("AWS/ApplicationELB", { LoadBalancer: alb }),
    ecs: resource("AWS/ECS", { ClusterName: cluster, ServiceName: service }),
    rds: resource("AWS/RDS", { DBInstanceIdentifier: database }),
    "s3-capacity": resource("AWS/S3", { BucketName: bucket }),
    cloudfront: resource("AWS/CloudFront", { DistributionId: distribution, Region: "Global" }),
  };
}

function cloudWatch(region: string, injected?: AwsTelemetryOptions["cloudWatchClient"]): NonNullable<AwsTelemetryOptions["cloudWatchClient"]> {
  if (injected) return injected;
  let client = clients.get(region);
  if (!client) {
    // Default task-role credential provider; never read or return credential values.
    client = new CloudWatchClient({ region, maxAttempts: 2 });
    clients.set(region, client);
  }
  return client;
}

async function deadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error("AWS_TELEMETRY_TIMEOUT")); }, DEADLINE_MS);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

function metric(spec: Pick<MetricSpec, "key" | "label" | "unit">, value: number | null, note: string): AwsTelemetryMetric {
  return { key: spec.key, label: spec.label, unit: spec.unit, value, previous: null, status: value === null ? "unavailable" : "available", note };
}

async function metricBatch(
  items: MetricSpec[], scope: Record<ServiceKey, Resource>, client: NonNullable<AwsTelemetryOptions["cloudWatchClient"]>, now: Date, daily = false,
): Promise<AwsTelemetryMetric[]> {
  if (!items.length) return [];
  const periodMs = daily ? DAY_MS : PERIOD_MS;
  const end = new Date(Math.floor(now.getTime() / periodMs) * periodMs);
  const start = new Date(end.getTime() - (daily ? 3 * DAY_MS : 3 * PERIOD_MS));
  const queries: MetricDataQuery[] = items.map((item, index) => ({
    Id: `m${index}`, ReturnData: true,
    MetricStat: {
      Metric: { Namespace: scope[item.service].namespace, MetricName: item.name,
        Dimensions: [...scope[item.service].dimensions, ...(daily ? [{ Name: "StorageType", Value: item.name === "NumberOfObjects" ? "AllStorageTypes" : "StandardStorage" }] : [])] },
      Period: periodMs / 1000, Stat: item.stat,
    },
  }));
  try {
    const response = await deadline((abortSignal) => client.send(new GetMetricDataCommand({
      StartTime: start, EndTime: end, ScanBy: "TimestampDescending", MaxDatapoints: 100, MetricDataQueries: queries,
    }), { abortSignal })) as GetMetricDataOutput;
    // A paginated/partial response must never silently masquerade as a complete snapshot.
    if (response.NextToken) throw new Error("INCOMPLETE_METRICS");
    const points = new Map<string, Point>();
    const metrics = items.map((item, index) => {
      const result = response.MetricDataResults?.find((row) => row.Id === `m${index}`);
      let newest: Point | undefined;
      if (result?.StatusCode === "Complete") {
        for (let i = 0; i < (result.Values?.length ?? 0); i++) {
          const value = result.Values?.[i];
          const timestamp = result.Timestamps?.[i];
          const time = timestamp instanceof Date ? timestamp.getTime() : NaN;
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isFinite(time) || time < start.getTime() || time >= end.getTime()) continue;
          if (!newest || time > newest.at.getTime()) newest = { value, at: new Date(time) };
        }
      }
      if (newest) points.set(item.key, newest);
      const value = newest ? newest.value * (item.factor ?? 1) : null;
      const note = newest
        ? `CloudWatch ${daily ? "daily observation" : "5-minute interval starting"} ${newest.at.toISOString()}. ${item.explanation ?? ""}`.trim()
        : "No complete, recent CloudWatch datapoint was returned. Missing data is not zero usage.";
      return metric(item, value !== null && Number.isFinite(value) ? value : null, note);
    });
    if (items.some((item) => item.key === "apiRequests")) {
      const requests = points.get("apiRequests");
      for (const spec of rateSpecs) {
        const errors = points.get(spec.numerator);
        const value = requests && errors && requests.value > 0 && requests.at.getTime() === errors.at.getTime()
          ? 100 * errors.value / requests.value : null;
        metrics.push(metric(spec, value !== null && Number.isFinite(value) ? value : null,
          value !== null ? `Target responses divided by routed requests for the same 5-minute interval starting ${requests!.at.toISOString()}. Excludes load balancer-generated errors.`
            : "A rate requires observed target errors and positive request counts from the same interval. Missing errors are not treated as zero."));
      }
    }
    return metrics;
  } catch {
    return items.map((item) => metric(item, null, "CloudWatch read failed, timed out, or returned an incomplete response. Verify configured resources and read permissions."));
  }
}

interface CostObservation { metric: AwsTelemetryMetric; checkedAt: string }
const costSpec = { key: "awsCost", label: "AWS month-to-date cost", unit: "USD" };

async function costs(options: AwsTelemetryOptions, env: NodeJS.ProcessEnv, now: Date): Promise<CostObservation> {
  const checkedAt = now.toISOString();
  const unavailable = (note: string): CostObservation => ({ metric: metric(costSpec, null, note), checkedAt });
  const account = configured(env, "COST_LINKED_ACCOUNT", /^\d{12}$/);
  const tagKey = configured(env, "COST_TAG_KEY", /^[A-Za-z0-9 _.:/=+@-]{1,128}$/);
  const tagValue = configured(env, "COST_TAG_VALUE", /^[A-Za-z0-9 _.:/=+@-]{1,256}$/);
  if (env.PACKPROOF_ADMIN_COSTS_ENABLED !== "true" || !account) return unavailable("Cost Explorer requires explicit enablement and an allowlisted linked account. No costs are inferred.");
  if ((env.PACKPROOF_ADMIN_COST_TAG_KEY || env.PACKPROOF_ADMIN_COST_TAG_VALUE) && !(tagKey && tagValue)) return unavailable("The optional cost allocation tag filter is incomplete or invalid; no unfiltered fallback was made.");
  const end = checkedAt.slice(0, 10);
  const start = `${end.slice(0, 7)}-01`;
  if (end === start) return unavailable("No completed UTC day is available in the current month. Today's incomplete costs are excluded.");
  const client = options.costExplorerClient ?? (defaultCostClient ??= new CostExplorerClient({ region: "us-east-1", maxAttempts: 2 }));
  let entries = costCache.get(client);
  if (!entries) { entries = new Map(); costCache.set(client, entries); }
  const cacheKey = JSON.stringify([start, end, account, tagKey, tagValue]);
  const cached = entries.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.pending;
  if (entries.size >= 32) entries.clear();
  const accountFilter = { Dimensions: { Key: "LINKED_ACCOUNT" as const, Values: [account] } };
  const pending = (async (): Promise<CostObservation> => {
    try {
      const response = await deadline((abortSignal) => client.send(new GetCostAndUsageCommand({
        TimePeriod: { Start: start, End: end }, Granularity: "DAILY", Metrics: ["UnblendedCost"],
        Filter: tagKey && tagValue ? { And: [accountFilter, { Tags: { Key: tagKey, Values: [tagValue], MatchOptions: ["EQUALS"] } }] } : accountFilter,
      }), { abortSignal })) as GetCostAndUsageCommandOutput;
      const rows = response.ResultsByTime ?? [];
      const expectedDays = (Date.parse(end) - Date.parse(start)) / DAY_MS;
      if (response.NextPageToken || rows.length !== expectedDays) throw new Error("INCOMPLETE_COSTS");
      let amount = 0;
      let estimated = false;
      const seen = new Set<string>();
      for (const row of rows) {
        const from = row.TimePeriod?.Start;
        const to = row.TimePeriod?.End;
        const total = row.Total?.UnblendedCost;
        if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
          || from < start || to > end || Date.parse(to) - Date.parse(from) !== DAY_MS || seen.has(from)
          || total?.Unit !== "USD" || typeof total.Amount !== "string" || !/^-?\d+(?:\.\d+)?$/.test(total.Amount)
          || !Number.isFinite(Number(total.Amount)) || typeof row.Estimated !== "boolean") throw new Error("INVALID_COSTS");
        seen.add(from);
        amount += Number(total.Amount);
        estimated ||= row.Estimated;
      }
      if (!Number.isFinite(amount)) throw new Error("INVALID_COSTS");
      return {
        checkedAt,
        metric: metric(costSpec, amount, `Cost Explorer unblended cost for ${tagKey ? "the configured account and cost allocation tag" : "the configured account (all services; not attributed solely to PackProof)"}; ${start} through ${end} exclusive. Retrieved ${checkedAt}. ${estimated ? "AWS marks some costs estimated; charges can change." : "AWS returned non-estimated daily costs."} AWS does not provide a billing refresh timestamp in this response. Cached up to 6 hours; today's incomplete costs excluded.`),
      };
    } catch { return unavailable("Cost Explorer read failed, timed out, or returned incomplete data. Verify billing access and the configured scope; no estimate is fabricated."); }
  })();
  const entry = { pending, expiresAt: Date.now() + COST_CACHE_MS };
  entries.set(cacheKey, entry);
  void pending.then((value) => { if (value.metric.value === null) entry.expiresAt = Date.now() + 30_000; });
  return pending;
}

async function alarms(options: AwsTelemetryOptions, env: NodeJS.ProcessEnv, region: string | undefined, checkedAt: string): Promise<AwsTelemetryResult["services"][number] | undefined> {
  const raw = env.PACKPROOF_ADMIN_CLOUDWATCH_ALARMS;
  if (!raw) return undefined;
  const names = [...new Set(raw.split(",").map((name) => name.trim()))];
  const item = (status: "healthy" | "warning" | "unavailable", detail: string) => ({ key: "aws-alarms", label: "Configured CloudWatch alarms", status, detail, checkedAt });
  if (!region || !names.length || names.length > 20 || names.some((name) => !/^[A-Za-z0-9_.:/+=@ -]{1,255}$/.test(name))) return item("unavailable", "The explicit CloudWatch alarm allowlist or AWS region is invalid.");
  try {
    const result = await deadline((abortSignal) => cloudWatch(region, options.cloudWatchClient).send(new DescribeAlarmsCommand({
      AlarmNames: names, AlarmTypes: ["MetricAlarm", "CompositeAlarm"], MaxRecords: 100,
    }), { abortSignal })) as DescribeAlarmsOutput;
    const rows = [...(result.MetricAlarms ?? []), ...(result.CompositeAlarms ?? [])].filter((row) => row.AlarmName && names.includes(row.AlarmName));
    const alerting = rows.filter((row) => row.StateValue === "ALARM").length;
    if (alerting) return item("warning", `${alerting} configured alarms report ALARM. Alarm messages and resource identifiers are omitted.`);
    if (result.NextToken || new Set(rows.map((row) => row.AlarmName)).size !== names.length || rows.some((row) => row.StateValue !== "OK")) return item("unavailable", "Some configured alarms are missing or lack sufficient data; infrastructure health is unverified.");
    return item("healthy", `${names.length} configured alarms currently report OK. This covers those alarm thresholds only; it does not establish complete infrastructure health.`);
  } catch { return item("unavailable", "The configured CloudWatch alarms could not be read within the deadline."); }
}

/** Read-only, explicitly scoped AWS observations. The caller caches complete snapshots for 30s. */
export async function awsTelemetry(options: AwsTelemetryOptions = {}): Promise<AwsTelemetryResult> {
  const env = options.env ?? process.env;
  const now = (options.clock ?? systemClock).now();
  const checkedAt = now.toISOString();
  const scope = resources(env);
  const region = configured(env, "AWS_REGION", /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/);
  const active = specs.filter((item) => scope[item.service].configured && (item.service === "cloudfront" || region));
  const regional = active.filter((item) => item.service !== "cloudfront" && item.service !== "s3-capacity");
  const daily = active.filter((item) => item.service === "s3-capacity");
  const global = active.filter((item) => item.service === "cloudfront");
  const [regionalMetrics, dailyMetrics, globalMetrics, cost, alarm] = await Promise.all([
    regional.length && region ? metricBatch(regional, scope, cloudWatch(region, options.cloudWatchClient), now) : [],
    daily.length && region ? metricBatch(daily, scope, cloudWatch(region, options.cloudWatchClient), now, true) : [],
    global.length ? metricBatch(global, scope, cloudWatch("us-east-1", options.cloudWatchClient), now) : [],
    costs(options, env, now), alarms(options, env, region, checkedAt),
  ]);
  const observations = [...regionalMetrics, ...dailyMetrics, ...globalMetrics];
  const allSpecs = [...specs, ...rateSpecs];
  const metrics = allSpecs.map((item) => observations.find((observation) => observation.key === item.key)
    ?? metric(item, null, "The explicit AWS resource allowlist or region is not configured or is invalid. No discovery was attempted."));
  const services: AwsTelemetryResult["services"] = (Object.keys(serviceLabels) as ServiceKey[]).map((key) => {
    const keys = allSpecs.filter((item) => item.service === key).map((item) => item.key);
    const available = metrics.filter((item) => keys.includes(item.key) && item.status === "available").length;
    return { key, label: serviceLabels[key], status: "unavailable", checkedAt,
      detail: available ? `${available}/${keys.length} configured metrics observed. Resource health is not established by utilization or traffic metrics; consult configured alarms and probes.` : "No recent telemetry is available for the explicitly configured resource. Check configuration, data coverage and read permissions." };
  });
  services.push({ key: "aws-cost", label: "AWS billing", status: "unavailable", checkedAt: cost.checkedAt,
    detail: cost.metric.value === null ? cost.metric.note! : "Cost data is available for the period and scope shown in the cost metric. Billing data does not establish service health." });
  if (alarm) services.push(alarm);
  return { checkedAt, metrics: [...metrics, cost.metric], services,
    notices: ["AWS reads use explicit resource allowlists, a four-second deadline and at most one retry per request. Missing datapoints remain unavailable.",
      "Traffic and capacity values are recent complete five-minute observations; S3 values are delayed daily observations. Each available metric states its observation time.",
      "S3 bytes cover StandardStorage only; all-class object counts include versions and multipart parts. Utilization alone is not a health check."] };
}
