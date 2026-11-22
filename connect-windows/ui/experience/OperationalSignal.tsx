import type { OrderSummary } from "../workspace-types";
import type { ConnectStatus } from "../types";
import { Icon } from "./Icon";
import { orderUpdate } from "./WorkspaceModel";
import { operationsOverview } from "./operations-overview";
import "./OperationalSignal.css";

interface Props {
  status: ConnectStatus;
  needsAttention: string;
  onOrders: () => void;
  onAttention: () => void;
  onConnections: () => void;
  onProof: (proofId: string, revision: number) => void;
}

function orderWhen(order: OrderSummary): string {
  if (!order.updatedAt || !Number.isFinite(Date.parse(order.updatedAt))) return "Time unavailable";
  return new Date(order.updatedAt).toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}

/**
 * Figma "04 / Dashboard — continuous operations", but with actual service
 * observations and honest unavailable states instead of illustrative metrics.
 * All buttons retain the authorized existing Workspace/Proof routes.
 */
export function OperationalSignal({
  status, needsAttention, onOrders, onAttention, onConnections, onProof,
}: Props) {
  const model = operationsOverview(status);
  const max = Math.max(1, ...model.buckets.map(({ count }) => count));
  const metrics = [
    {
      title: "Orders observed",
      value: model.metrics.observedOrders,
      caption: model.metrics.observedCaption,
      icon: "records",
      action: onOrders,
    },
    {
      title: "Orders updated",
      value: model.metrics.updatedOrders,
      caption: model.metrics.updatedCaption,
      icon: "activity",
      action: onOrders,
    },
    {
      title: "Connected sources",
      value: model.metrics.connectedSources,
      caption: model.metrics.connectedCaption,
      icon: "connection",
      action: onConnections,
    },
    {
      title: "Needs attention",
      value: model.canRead ? needsAttention : "—",
      caption: model.canRead ? "Orders and sources to review" : "Reconnect to review",
      icon: "attention",
      action: onAttention,
    },
  ];
  return (
    <section
      className="eo-overview"
      aria-labelledby="eo-heading"
      data-design-file="nNnkgTZOBNkG8muy8AkIv1"
      data-design-node="3:262"
    >
      <header className="eo-overview-head">
        <span className="eo-overview-eyebrow">PACKPROOF / LIVE OPERATIONS</span>
        <h1 id="eo-heading">Operations, at a glance.</h1>
        <p>What your approved systems are recording, and what needs a closer look.</p>
        <button
          className={"eo-health " + (model.online ? "eo-health-live" : "eo-health-interrupted")}
          onClick={onConnections}
          title="Open the actual connection status"
        >
          <span className="eo-health-pulse" aria-hidden="true" />
          <span><strong>{model.healthLabel}</strong><small>{model.healthDetail}</small></span>
          <span className="eo-health-arrow" aria-hidden="true">›</span>
        </button>
      </header>
      <div className="eo-metrics" aria-label="Live workspace metrics">
        {metrics.map((metric) => (
          <button
            type="button"
            className="eo-metric"
            key={metric.title}
            onClick={metric.action}
          >
            <span className="eo-metric-label">{metric.title}</span>
            <Icon name={metric.icon} size={25} />
            <strong>{metric.value}</strong>
            <small>{metric.caption}</small>
            <span className="eo-metric-stripe" aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="eo-activity-layout">
        <section className="eo-panel eo-chart" aria-label="Recent visible order update hours">
          <header>
            <h2>Evidence moving through your facility</h2>
            <p>
              {model.bucketBasis === "recent-page"
                ? `${model.datedOrders} visible orders with dated updates in the last 12 hours`
                : "Waiting for recent dated order updates"}
            </p>
          </header>
          {model.bucketBasis === "recent-page" ? (
            <>
              <div
                className="eo-bars"
                role="img"
                aria-label="Hourly distribution of recent visible order updates; not facility-wide event throughput"
              >
                {model.buckets.map((bucket, i) => (
                  <div className="eo-bar-cell" key={bucket.start} title={`${bucket.label}: ${bucket.count} visible order updates`}>
                    <div
                      className={"eo-bar " + (i >= 9 ? "eo-bar-latest" : "")}
                      style={{ height: `${Math.max(4, Math.round(bucket.count / max * 100))}%`, animationDelay: `${i * 55}ms` }}
                    />
                  </div>
                ))}
              </div>
              <div className="eo-chart-axis">
                <span>{model.buckets[0].label}</span>
                <span>{model.buckets[6].label}</span>
                <span>{model.buckets[11].label}</span>
              </div>
            </>
          ) : (
            <div className="eo-no-activity" role="status">
              <Icon name="activity" size={38} />
              <span>No timestamped order updates are available in the current page.</span>
            </div>
          )}
          <p className="eo-activity-disclosure">
            Recent visible orders only. This chart is not a facility-wide throughput estimate.
          </p>
        </section>
        <section className="eo-panel eo-feed" aria-label="Recent order evidence">
          <header>
            <h2>Live intelligence feed</h2>
            <p>Latest visible Proof revisions</p>
          </header>
          {!model.canRead ? (
            <p className="eo-feed-empty">Reconnect to your approved workspace to view current updates.</p>
          ) : model.activity.length ? (
            <div className="eo-feed-list">
              {model.activity.map((order) => (
                <button
                  key={order.proofId}
                  className="eo-feed-entry"
                  onClick={() => onProof(order.proofId, order.revision)}
                >
                  <span className={"eo-feed-dot " + (order.issue ? "eo-feed-warn" : "")} aria-hidden="true" />
                  <span className="eo-feed-copy">
                    <strong>{orderUpdate(order)}</strong>
                    <small>{order.orderReference} · {orderWhen(order)}</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="eo-feed-empty">The first order will appear after an approved source is ingested.</p>
          )}
        </section>
      </div>
    </section>
  );
}
