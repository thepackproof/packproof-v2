import { useCallback, useEffect, useRef, useState } from "react";
import type { AttentionReport, OrderSummary, WorkspaceStep } from "../workspace-types";
import type { ConnectStatus } from "../types";
import { Icon } from "./Icon";
import { Connections } from "./WorkspaceConnections";
import { OperationalSignal } from "./OperationalSignal";
import { MatchingWorkspace, IntegrityWorkspace, ExportsWorkspace, WorkstationSettings } from "./WorkspaceDestinations";
import { OrderRows, OrdersView } from "./WorkspaceOrdersView";
import {
  reportError,
  sourceTitle,
  sourceIssue,
  sourceIcon,
  type WorkspaceProps,
  type RunAction,
} from "./WorkspaceModel";
import "./Workspace.css";

export type { WorkspaceSection, WorkspaceProps } from "./WorkspaceModel";
type Review = {
  key: string;
  icon: string;
  subject: string;
  title: string;
  detail: string;
  action: string;
  open: () => void;
};
export function Workspace(props: WorkspaceProps) {
  const ws = props.status.workspace;
  if (!ws) return <p role="status">Checking your workspace…</p>;
  return (
    <WorkspaceView
      key={JSON.stringify([props.status.installationId, ws.viewKey, ws.canReadOrders !== false])}
      {...props}
    />
  );
}
function WorkspaceView(props: WorkspaceProps) {
  const { section, status, bridge, onStatus, onBusyChange, onProof, onSection } = props;
  const ws = status.workspace!,
    readable = ws.canReadOrders !== false;
  const [sourceId, setSourceId] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""),
    [failure, setFailure] = useState("");
  const [olderIssues, setOlderIssues] = useState<OrderSummary[]>([]),
    [issueCursor, setIssueCursor] = useState<number | null | undefined>(undefined);
  const pageEpoch = useRef(0);
  const [report, setReport] = useState<AttentionReport | null>(null),
    [reviewError, setReviewError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const lock = useRef(false),
    alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setSourceId(null);
    setFailure("");
    setNotice("");
  }, [section]);
  const run: RunAction = useCallback(
    async (fn, success) => {
      if (lock.current) return;
      lock.current = true;
      setBusy(true);
      setNotice("");
      setFailure("");
      onBusyChange?.(true);
      try {
        const next = await fn();
        if (!alive.current) return;
        if (next && typeof next === "object" && "environment" in next && "health" in next)
          onStatus(next as ConnectStatus);
        if (success) setNotice(success);
      } catch (e) {
        if (alive.current) setFailure(reportError(e, "The action could not be completed. Try again."));
      } finally {
        lock.current = false;
        onBusyChange?.(false);
        if (alive.current) setBusy(false);
      }
    },
    [onStatus, onBusyChange],
  );
  const edit = (step: WorkspaceStep) => {
    if (props.onEditStep) void props.onEditStep(step);
    else void run(() => bridge.saveWorkspaceStep(step));
  };
  const [requestedSource, setRequestedSource] = useState<string | null>(null);
  useEffect(() => {
    if (section === "connections" && requestedSource) {
      setSourceId(requestedSource);
      setRequestedSource(null);
    }
  }, [section, requestedSource]);
  const openSource = (id: string) => {
    setRequestedSource(id);
    onSection("connections");
  };
  const sources = ws.sources.filter((s) => s.roles.length),
    recent = readable ? ws.orders || [] : [];
  const wantsReview = readable && (section === "attention" || section === "home" || section === "matching");
  const revisionKey = recent.map((o) => o.proofId + "/" + o.revision).join(",");
  const lastReview = useRef({ key: "", requested: 0 });
  // Keep an active receiving dock from triggering a broad comparison on every import.
  useEffect(() => {
    if (!wantsReview || !lastReview.current.requested || revisionKey === lastReview.current.key) return;
    const delay = Math.max(0, lastReview.current.requested + 30000 - Date.now());
    const timer = setTimeout(() => setAttempt((v) => v + 1), delay);
    return () => clearTimeout(timer);
  }, [wantsReview, revisionKey, section, attempt]);
  useEffect(() => {
    pageEpoch.current++;
    setOlderIssues([]);
    setIssueCursor(undefined);
    if (!wantsReview) return;
    lastReview.current = { key: revisionKey, requested: Date.now() };
    let active = true;
    const refresh = async () => {
      try {
        const next = await bridge.workspaceAttention();
        if (active) {
          setReport(next);
          setReviewError("");
        }
      } catch (e) {
        if (active) {
          setReviewError(reportError(e, "Couldn't check the review queue. Reconnect and try again."));
          setReport(null);
        }
      }
    };
    void refresh();
    return () => {
      active = false;
    };
  }, [bridge, wantsReview, attempt, section]);
  const sourceIssues = sources.filter(
    (s) =>
      sourceIssue(s) &&
      !(s.issue === "IDENTITY_UNRESOLVED" && report?.items.some((r) => r.sourceId === s.id)),
  );
  const localCopies = status.proofOutput,
    outputIssue =
      !!localCopies &&
      (localCopies.pending > 0 || ["access_denied", "unavailable", "pending"].includes(localCopies.state));
  const firstPage = report?.orderIssues || recent.filter((o) => o.issue);
  const ordersToReview = [
    ...firstPage,
    ...olderIssues.filter((o) => !firstPage.some((x) => x.proofId === o.proofId)),
  ];
  const nextIssues = issueCursor === undefined ? report?.nextIssuesBefore : issueCursor;
  const moreIssues = () =>
    run(async () => {
      if (!nextIssues) return;
      const epoch = pageEpoch.current;
      const page = await bridge.workspaceAttention(nextIssues);
      if (!alive.current || epoch !== pageEpoch.current) return;
      setOlderIssues((prev) => [
        ...prev,
        ...(page.orderIssues || []).filter((o) => !prev.some((p) => p.proofId === o.proofId)),
      ]);
      setIssueCursor(page.nextIssuesBefore ?? null);
    });
  const orderReview = (o: OrderSummary): Review => ({
    key: "proof/" + o.proofId,
    icon: "attention",
    subject: "Order " + o.orderReference + (o.customerName ? " · " + o.customerName : ""),
    title: o.issue || "Review source values",
    detail: "Open the Proof to compare the source records.",
    action: "Review proof",
    open: () => onProof(o.proofId, o.revision),
  });
  const reviews: Review[] = [
    ...ordersToReview.map(orderReview),
    ...sourceIssues.map((s) => ({
      key: "source/" + s.id,
      icon: sourceIcon(s),
      subject: sourceTitle(s),
      title: "Source needs attention",
      detail: sourceIssue(s),
      action: "Review connection",
      open: () => openSource(s.id),
    })),
    ...(report?.items || []).map((r, i) => {
      const source = sources.find((s) => s.id === r.sourceId);
      return {
        key: "link/" + i,
        icon: "records",
        subject: source ? sourceTitle(source) : "Source record",
        title: r.fileName || "Record awaiting an order link",
        detail: [r.reason || "Review the order reference.", r.locator].filter(Boolean).join(" · "),
        action: r.proofId && r.revision ? "Review proof" : "Review source link",
        open: () => {
          if (r.proofId && r.revision) onProof(r.proofId, r.revision);
          else void run(() => bridge.openWorkspaceReview());
        },
      };
    }),
    ...(outputIssue
      ? [
          {
            key: "output",
            icon: "folder",
            subject: "Proof folder",
            title: "Local copies pending",
            detail: "Check the proof folder so PackProof can save the latest revisions.",
            action: "Check proof folder",
            open: () => edit("output"),
          },
        ]
      : []),
  ];
  const n =
    (report?.orderIssueCount ?? ordersToReview.length) +
    sourceIssues.length +
    (report?.items.length || 0) +
    (outputIssue ? 1 : 0);
  const exact = !!report && typeof report.orderIssueCount === "number" && !report.hasMore;
  const countLabel = exact ? String(n) : n ? String(n) + "+" : "—";
  const reviewStatus = reviewError ? (
    <p role="alert" className="xw-warning">
      {reviewError}
    </p>
  ) : !readable ? (
    <p className="xw-notice">Reconnect to your approved workspace to check its records.</p>
  ) : !report ? (
    <p className="xw-empty" role="status">
      Checking records that need review…
    </p>
  ) : null;
  const reviewControls = (
    <button className="xw-link" disabled={busy} onClick={() => setAttempt((v) => v + 1)}>
      Refresh review
    </button>
  );
  return (
    <div className="xw" aria-busy={busy || undefined}>
      {failure && (
        <div role="alert" className="xw-warning">
          {failure}
        </div>
      )}
      {notice && (
        <div role="status" className="xw-notice">
          {notice}
        </div>
      )}
      {section === "orders" && <OrdersView status={status} bridge={bridge} onProof={onProof} />}
      {section === "connections" && (
        <Connections
          {...props}
          onEditStep={edit}
          busy={busy}
          run={run}
          sourceId={sourceId}
          onSource={setSourceId}
        />
      )}
      {section === "matching" && (
        <MatchingWorkspace
          status={status}
          bridge={bridge}
          busy={busy}
          run={run}
          onSection={onSection}
          onProof={onProof}
          onOutputSetup={() => edit("output")}
          report={report}
          error={reviewError}
          onRefresh={() => setAttempt((v) => v + 1)}
        />
      )}
      {section === "integrity" && (
        <IntegrityWorkspace
          status={status}
          bridge={bridge}
          busy={busy}
          run={run}
          onSection={onSection}
          onProof={onProof}
          onOutputSetup={() => edit("output")}
        />
      )}
      {section === "exports" && (
        <ExportsWorkspace
          status={status}
          bridge={bridge}
          busy={busy}
          run={run}
          onSection={onSection}
          onProof={onProof}
          onOutputSetup={() => edit("output")}
        />
      )}
      {section === "settings" && (
        <WorkstationSettings
          status={status}
          bridge={bridge}
          busy={busy}
          run={run}
          onSection={onSection}
          onProof={onProof}
          onOutputSetup={() => edit("output")}
        />
      )}
      {section === "attention" && (
        <>
          <header className="xw-heading">
            <div>
              <h1>Needs attention</h1>
              <p>
                {exact ? (n === 1 ? "One item needs" : n + " items need") + " a closer look. " : ""}Select an
                item to review its proof or repair its connection.
              </p>
            </div>
            {readable && reviewControls}
          </header>
          {reviewStatus}
          <div className="xw-reviewlist">
            {reviews.map((r) => (
              <button className="xw-card xw-review" onClick={r.open} key={r.key} disabled={busy}>
                <Icon name={r.icon} size={44} />
                <span className="xw-reviewtext">
                  <small>{r.subject}</small>
                  <strong>{r.title}</strong>
                  <span>{r.detail}</span>
                </span>
                <span className="xw-cta">{r.action} ›</span>
              </button>
            ))}
          </div>
          {!reviews.length && report && (
            <p className="xw-card xw-empty">No issues reported in your checked records or sources.</p>
          )}
          {nextIssues ? (
            <button className="xw-link" disabled={busy} onClick={() => void moreIssues()}>
              Load more orders needing review ↓
            </button>
          ) : null}
          {report?.hasMore && (
            <p className="xw-notice">
              <button className="xw-link" onClick={() => void run(() => bridge.openWorkspaceReview())}>
                See all unlinked records online →
              </button>
            </p>
          )}
        </>
      )}
      {section === "home" && (
        <>
          <OperationalSignal
            status={status}
            needsAttention={countLabel}
            onOrders={() => onSection("orders")}
            onAttention={() => onSection("attention")}
            onConnections={() => onSection("connections")}
            onProof={onProof}
          />
          <div className="xw-homecols">
            <section className="xw-card xw-recent">
              <div className="xw-cardhead">
                <h2>Recent orders</h2>
                <button className="xw-link" onClick={() => onSection("orders")}>
                  View all orders →
                </button>
              </div>
              {recent.length ? (
                <OrderRows orders={recent.slice(0, 4)} compact onProof={onProof} />
              ) : (
                <p className="xw-empty">
                  {!readable
                    ? "Reconnect to your approved workspace to see its orders."
                    : ws.syncState === "pending"
                      ? "Checking for the latest orders."
                      : "Waiting for the first order."}
                </p>
              )}
            </section>
            <section className="xw-card xw-reviewmini">
              <h2>{exact ? (n === 1 ? "1 item" : n + " items") + " to review" : "Items to review"}</h2>
              <p>Open an item to see what needs attention.</p>
              {reviewStatus}
              {reviews.slice(0, 4).map((r) => (
                <button key={r.key} disabled={busy} onClick={r.open}>
                  <Icon name={r.icon} size={31} />
                  <span>
                    <strong>{r.subject}</strong>
                    <small>{r.title}</small>
                  </span>
                </button>
              ))}
              {!reviews.length && report && <p>No issues reported.</p>}
              {reviews.length > 4 && (
                <button className="xw-link" onClick={() => onSection("attention")}>
                  View all items →
                </button>
              )}
              {reviewError && reviewControls}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
