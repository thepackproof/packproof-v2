import { useEffect, useRef, useState } from "react";
import type { OrderSummary } from "../workspace-types";
import type { WorkspaceProps } from "./WorkspaceModel";
import { canReadWorkspace, orderUpdate, reportError } from "./WorkspaceModel";
import { Icon } from "./Icon";

export function OrderRows({
  orders,
  onProof,
  compact = false,
}: {
  orders: OrderSummary[];
  onProof: WorkspaceProps["onProof"];
  compact?: boolean;
}) {
  return (
    <div
      className={compact ? "xw-orderlist xw-compact" : "xw-orderlist"}
      aria-label={compact ? "Recent orders" : "Order list"}
    >
      {!compact && (
        <div aria-hidden="true" className="xw-gridrow xw-colheads">
          <span>Order</span>
          <span>Customer</span>
          <span>Latest update</span>
          <span>Status</span>
          <span />
        </div>
      )}
      {orders.map((order) => (
        <button
          type="button"
          className="xw-gridrow xw-orderrow"
          key={order.proofId}
          onClick={() => onProof(order.proofId, order.revision)}
        >
          <span className="xw-order-identity">
            <strong>
              {!compact && <Icon name="order" size={27} />}
              <span>{order.orderReference}</span>
            </strong>
            <span className="xw-customer">{order.customerName || "Unreported"}</span>
          </span>
          <span className="xw-update">{orderUpdate(order)}</span>
          <span className={"xw-badge " + (order.issue ? "xw-warn" : "xw-blue")}>
            {order.issue ? "Needs review" : order.fulfillmentStatus || "Recorded"}
          </span>
          {!compact && (
            <span className="xw-arrow" aria-hidden="true">
              ›
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
export function OrdersView({
  status,
  bridge,
  onProof,
}: Pick<WorkspaceProps, "status" | "bridge" | "onProof">) {
  const ws = status.workspace!;
  const [input, setInput] = useState(""),
    [query, setQuery] = useState(""),
    [error, setError] = useState("");
  const [found, setFound] = useState<OrderSummary[] | null>(null),
    [older, setOlder] = useState<OrderSummary[]>([]);
  const [after, setAfter] = useState<number | null | undefined>(undefined),
    [pending, setPending] = useState(false);
  const seq = useRef(0);
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  const readable = canReadWorkspace(status),
    recent = readable ? ws.orders || [] : [];
  // An order keeps the same canonical Proof ID as corrections and late records
  // append revisions. Pagination and search may return overlapping snapshots:
  // always open the newest observed revision, never the first row encountered.
  const latestRecent = new Map<string, OrderSummary>();
  for (const row of recent) {
    const previous = latestRecent.get(row.proofId);
    if (!previous || row.revision > previous.revision) latestRecent.set(row.proofId, row);
  }
  const deduped = new Map<string, OrderSummary>();
  for (const row of query ? found || [] : [...recent, ...older]) {
    const recentVersion = latestRecent.get(row.proofId);
    const current = recentVersion && recentVersion.revision > row.revision ? recentVersion : row;
    const previous = deduped.get(current.proofId);
    if (!previous || current.revision > previous.revision) deduped.set(current.proofId, current);
  }
  const display = [...deduped.values()],
    cursor = after === undefined ? ws.nextBefore : after;
  async function search(value: string) {
    const id = ++seq.current;
    setQuery(value);
    setFound(null);
    setError("");
    setPending(!!value);
    if (!value) return;
    try {
      const rows = await bridge.workspaceSearchOrders(value);
      if (id === seq.current) setFound(rows);
    } catch (e) {
      if (id === seq.current) setError(reportError(e, "Reconnect to search your orders."));
    } finally {
      if (id === seq.current) setPending(false);
    }
  }
  async function more() {
    if (!cursor || pending || !bridge.workspaceOrderPage) return;
    const id = ++seq.current;
    setPending(true);
    setError("");
    try {
      const page = await bridge.workspaceOrderPage(cursor);
      if (id === seq.current) {
        setOlder((old) => [...old, ...page.orders]);
        setAfter(page.nextBefore ?? null);
      }
    } catch (e) {
      if (id === seq.current) setError(reportError(e, "Couldn't load earlier orders."));
    } finally {
      if (id === seq.current) setPending(false);
    }
  }
  return (
    <>
      <header className="xw-heading">
        <div>
          <h1>Orders</h1>
          <p>Select an order to see what happened and which records support it.</p>
        </div>
      </header>
      {!readable ? (
        <p className="xw-notice" role="status">
          Reconnect to your approved workspace to see its orders.
        </p>
      ) : (
        <>
          <form
            className="xw-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search(input.trim());
            }}
          >
            <label>
              <Icon name="search" size={20} />
              <input
                type="search"
                aria-label="Order reference"
                placeholder="Order, pick ticket, carton, shipment or tracking number"
                maxLength={200}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  if (!e.target.value) void search("");
                }}
              />
            </label>
            <button className="xw-link" disabled={!input.trim() || pending}>
              Find order
            </button>
            {query && (
              <button
                type="button"
                className="xw-link"
                onClick={() => {
                  setInput("");
                  void search("");
                }}
              >
                Show recent orders
              </button>
            )}
          </form>
          {error && (
            <p className="xw-warning" role="alert">
              {error}
            </p>
          )}
          <section className="xw-card xw-table">
            <OrderRows orders={display} onProof={onProof} />
            {query && display.flatMap(order => (order.matchedSubjects || []).map(subject =>
              <p key={JSON.stringify([order.proofId,subject])}><button type="button" className="xw-link"
                onClick={() => void bridge.openWorkspaceOrder(order.proofId,order.revision,subject.id)
                  .catch(e => setError(reportError(e,"Could not open this matched subject.")))}>
                {subject.id} on {order.orderReference}</button> · {subject.namespace} · Revision {order.revision}</p>))}
            {!display.length && !error && (
              <p className="xw-empty" role="status">
                {pending
                  ? "Finding your order…"
                  : query
                    ? "No order with that reference was found."
                    : ws.syncState === "pending"
                      ? "Waiting for the latest orders."
                      : "Waiting for the first order."}
              </p>
            )}
            {!query && !!cursor && !!bridge.workspaceOrderPage && (
              <button className="xw-link" disabled={pending} onClick={() => void more()}>
                {pending ? "Loading…" : "Load earlier orders"} ↓
              </button>
            )}
          </section>
        </>
      )}
    </>
  );
}
