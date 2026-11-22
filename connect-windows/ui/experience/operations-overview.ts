import type { ConnectStatus } from "../types";
import type { OrderSummary } from "../workspace-types";

/**
 * Project ONLY information actually observed in the authorized workspace.
 *
 * The Windows design shows illustrative facility-wide volumes. Those values
 * must never appear in the installed application unless a live service reports
 * them. An order page is a sample of recent orders, not a throughput feed.
 */
export interface OperationsOverview {
  canRead: boolean;
  online: boolean;
  healthLabel: string;
  healthDetail: string;
  metrics: {
    observedOrders: string;
    observedCaption: string;
    updatedOrders: string;
    updatedCaption: string;
    connectedSources: string;
    connectedCaption: string;
  };
  bucketBasis: "recent-page" | "unavailable";
  buckets: { label: string; count: number; start: number }[];
  datedOrders: number;
  activity: OrderSummary[];
}

const HOUR_MS = 60 * 60 * 1000;
function timestamp(value?: string): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** The latest visible revision of each Proof, never a count of its events. */
function latestOrders(orders: OrderSummary[]) {
  const seen = new Map<string, OrderSummary>();
  for (const order of orders) {
    if (!order.proofId) continue;
    const earlier = seen.get(order.proofId);
    if (!earlier || earlier.revision < order.revision) seen.set(order.proofId, order);
  }
  return [...seen.values()].sort(
    (a, b) => (timestamp(b.updatedAt) ?? 0) - (timestamp(a.updatedAt) ?? 0),
  );
}

export function operationsOverview(
  status: ConnectStatus,
  now = Date.now(),
): OperationsOverview {
  const ws = status.workspace;
  const online =
    status.health.serviceOnline &&
    ws?.canReadOrders !== false &&
    !["unauthenticated", "forbidden", "unreachable"].includes(status.transport?.state || "");
  const canRead = online && !!ws;
  // Never retain an earlier page when the current facility scope is unavailable.
  const recent = canRead ? latestOrders(ws?.orders ?? []) : [];
  const sources = ws?.sources.filter((s) => s.roles.length > 0) ?? [];
  const connected = sources.filter((s) => s.state === "active").length;
  const issues = sources.filter(
    (s) => s.state === "needs_attention" || !!s.issue || !!s.coverageGap,
  ).length;

  const end = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS;
  const buckets = Array.from({ length: 12 }, (_, i) => {
    const start = end - (12 - i) * HOUR_MS;
    return {
      start,
      label: new Date(start).toLocaleTimeString(undefined, {
        hour: "numeric",
        hour12: true,
      }),
      count: 0,
    };
  });
  let datedOrders = 0;
  for (const order of recent) {
    const time = timestamp(order.updatedAt);
    if (time === null || time > now) continue;
    const i = Math.floor((time - buckets[0].start) / HOUR_MS);
    if (i >= 0 && i < buckets.length) {
      buckets[i].count += 1;
      datedOrders++;
    }
  }
  const totalsKnown = canRead && ws?.totalOrders != null;
  const updatedKnown =
    canRead && (ws?.updatedToday != null || ws?.updatedLast24Hours != null);
  const healthLabel = !status.health.serviceOnline
    ? "Background service offline"
    : !canRead
      ? "Workspace access needs attention"
      : ws?.phase !== "active"
        ? "Facility setup is not active"
        : connected
          ? issues
            ? "Collecting with exceptions"
            : "Sources collecting"
          : "No active source yet";
  return {
    online: !!online,
    canRead,
    healthLabel,
    healthDetail: !canRead
      ? "Reconnect or restore authorization to view current records."
      : issues
        ? `${issues} ${issues === 1 ? "source needs" : "sources need"} review.`
        : connected
          ? `${connected} approved ${connected === 1 ? "source is" : "sources are"} collecting.`
          : "Connect and approve a source to begin collection.",
    metrics: {
      observedOrders: !canRead ? "—" : totalsKnown ? String(ws?.totalOrders) : recent.length ? `${recent.length}+` : "—",
      observedCaption: totalsKnown ? "Workspace total" : "Recent visible page only",
      updatedOrders: updatedKnown
        ? String(ws?.updatedToday ?? ws?.updatedLast24Hours)
        : "—",
      updatedCaption: ws?.updatedToday != null ? "Updated today" : "Last 24 hours, if reported",
      connectedSources: !online ? "—" : `${connected}/${sources.length}`,
      connectedCaption: online ? "Approved sources collecting" : "Connection not confirmed",
    },
    bucketBasis: datedOrders > 0 ? "recent-page" : "unavailable",
    buckets,
    datedOrders,
    activity: recent.slice(0, 4),
  };
}
