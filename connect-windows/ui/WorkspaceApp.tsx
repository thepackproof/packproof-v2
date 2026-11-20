import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectApp } from "./ConnectApp";
import { getBridge, type ConnectBridge, type ConnectStatus } from "./types";
import type { DraftPreview, OrderDetail, WorkspaceStep } from "./workspace-types";
import { Header, Shell, type Section } from "./experience/Shell";
import { Workspace } from "./experience/Workspace";
import { Setup } from "./experience/Setup";
import { Proof } from "./experience/Proof";
import { draftProof, northSample, riversideSample, sampleOriginal } from "./experience/preview";
import "./experience/experience.css";

type Selection = { id: string; revision: number; scope: string };
type Draft = DraftPreview["examples"][number];
type SourceNames = Record<string, string>;

function LiveProof({
  bridge,
  selection,
  sourceNames,
  onBack,
}: {
  bridge: ConnectBridge;
  selection: Selection;
  sourceNames: SourceNames;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const { id, revision } = selection;
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError("");
    void bridge
      .workspaceOrderDetail(id, revision)
      .then((value) => {
        if (value.proofId !== id || value.revision !== revision)
          throw new Error("This order has changed. Reopen it from Orders.");
        if (active) setDetail(value);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "The order could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [bridge, id, revision, retry]);
  const openOnline = () =>
    void bridge
      .openWorkspaceOrder(id, revision)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not open the online order."));
  return (
    <>
      {error && (
        <div className="pp-system-notice" role="alert">
          {error}
          <button className="pp-text-button" onClick={() => setRetry((v) => v + 1)}>
            Try again
          </button>
        </div>
      )}
      {detail ? (
        <Proof
          detail={detail}
          onBack={onBack}
          sourceNames={sourceNames}
          readOriginal={bridge.workspaceSourceRecord}
          onOpenFullProof={openOnline}
        />
      ) : (
        <main className="pp-system-state">
          <button className="pp-text-button" onClick={onBack}>
            ‹ Back to orders
          </button>
          <h1>{error ? "Order unavailable" : "Opening your Proof"}</h1>
          {!error && <p role="status">Reading the saved order revision…</p>}
        </main>
      )}
    </>
  );
}
function Experience({
  status,
  bridge,
  accept,
  onBusyChange,
  onLegacy,
  serviceUnavailable,
}: {
  status: ConnectStatus;
  bridge: ConnectBridge;
  accept: (s: ConnectStatus) => void;
  onBusyChange: (busy: boolean) => void;
  onLegacy: () => void;
  serviceUnavailable: boolean;
}) {
  const ws = status.workspace!;
  const facilitySetup = new URLSearchParams(window.location.search).get("facilitySetup") === "1";
  const [setup, setSetup] = useState(() => facilitySetup || ws.step !== "overview" || ws.phase !== "active");
  const [section, setSection] = useState<Section>("home");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [tour, setTour] = useState(false);
  const [example, setExample] = useState(northSample);
  const [draft, setDraft] = useState<{ data: Draft; identity: string } | null>(null);
  const [error, setError] = useState("");
  const identity = JSON.stringify([
    status.environment,
    status.installationId,
    status.binding?.organizationId,
    status.state === "revoked",
  ]);
  const scope = JSON.stringify([identity, ws.viewKey, ws.canReadOrders]);
  const liveDraft =
    draft?.identity === identity && status.state !== "revoked" && !serviceUnavailable ? draft.data : null;
  const showSetup = setup || ws.phase !== "active" || ws.step !== "overview";
  const selected =
    selection?.scope === scope && ws.canReadOrders !== false && !serviceUnavailable ? selection : null;
  const latest = selected && ws.orders?.find((o) => o.proofId === selected.id);
  const revision = selected ? Math.max(selected.revision, latest?.revision ?? 0) : 0;
  const sourceNames = Object.fromEntries(
    ws.sources.map((s) => [
      s.id,
      s.transport === "api"
        ? s.displayName || s.sourceNamespace || "Connected system"
        : s.folder?.split(/[\\/]/).filter(Boolean).at(-1) || s.displayName || "Connected source",
    ]),
  );
  const open = (id: string, rev: number) => {
    if (facilitySetup) {
      void bridge.openWorkspaceOrder(id,rev).catch(e => setError(e instanceof Error ? e.message : "Could not open the signed-in order."));
      return;
    }
    setSelection({ id, revision: rev, scope });
    setError("");
  };
  const nav = (s: Section) => {
    setSection(s);
    setSelection(null);
    setError("");
  };
  const back = () => {
    setTour(false);
    setDraft(null);
    setSelection(null);
  };
  async function edit(step: WorkspaceStep) {
    onBusyChange(true);
    setError("");
    try {
      const result = await bridge.saveWorkspaceStep(step);
      accept(result);
      setSetup(true);
      setSelection(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open source settings.");
    } finally {
      onBusyChange(false);
    }
  }
  const overlay = tour || !!liveDraft || !!selected;
  return (
    <>
      <Header
        workspace={
          tour
            ? "Sample workspace"
            : status.binding?.organizationName || (!showSetup ? "Your workspace" : undefined)
        }
        action={overlay ? "‹ Back" : showSetup ? "Setup help" : undefined}
        onAction={
          overlay
            ? back
            : showSetup
              ? () => window.dispatchEvent(new Event("packproof-setup-help"))
              : undefined
        }
      />
      {error && (
        <div className="pp-system-notice" role="alert">
          {error}
        </div>
      )}
      {ws.attention && (
        <div className="pp-system-notice" role="status">
          {ws.attention}
        </div>
      )}
      {status.installationId && status.capabilities?.orderWorkspace === false && (
        <div className="pp-system-notice" role="status">
          Your server supports earlier connections. You can prepare sources here while the order workspace is
          being enabled.
          <button className="pp-text-button" onClick={onLegacy}>
            Manage earlier connections
          </button>
        </div>
      )}
      {showSetup && (
        <div hidden={overlay}>
          <Setup
            key={identity}
            status={status}
            bridge={bridge}
            onStatus={accept}
            onBusyChange={onBusyChange}
            onLegacy={onLegacy}
            onSample={() => {
              setExample(northSample);
              setTour(true);
            }}
            onOpenDraftProof={(data) => setDraft({ data, identity })}
            onOpenProof={(o) => open(o.proofId, o.revision)}
            onComplete={() => {
              if (facilitySetup) {
                void bridge.openWorkspaceReview().then(() => window.close())
                  .catch(e => setError(e instanceof Error ? e.message : "Could not open your signed-in workspace."));
                return;
              }
              setSetup(false);
              nav("home");
            }}
          />
        </div>
      )}
      {tour ? (
        <>
          <div className="pp-tour-picker">
            <label htmlFor="example-order">Sample order</label>
            <select
              id="example-order"
              value={example.proofId}
              onChange={(e) =>
                setExample(e.target.value === riversideSample.proofId ? riversideSample : northSample)
              }
            >
              <option value={northSample.proofId}>North Ridge Supply · 10482</option>
              <option value={riversideSample.proofId}>Riverside Mechanical · SO-104882</option>
            </select>
          </div>
          <Proof mode="sample" detail={example} onBack={back} readOriginal={sampleOriginal} />
        </>
      ) : liveDraft ? (
        <Proof mode="draft" detail={draftProof(liveDraft)} onBack={back} />
      ) : showSetup && selected && revision > 0 ? (
        <LiveProof
          key={scope + selected.id + revision}
          bridge={bridge}
          selection={{ ...selected, revision }}
          sourceNames={sourceNames}
          onBack={back}
        />
      ) : !showSetup ? (
        <Shell status={status} section={selected ? "orders" : section} onSection={nav}>
          {!serviceUnavailable && (
            <div hidden={!!selected}>
              <Workspace
                key={scope}
                section={section}
                status={status}
                bridge={bridge}
                onStatus={accept}
                onSection={nav}
                onProof={open}
                onEditStep={edit}
                onLegacy={onLegacy}
                onBusyChange={onBusyChange}
              />
            </div>
          )}
          {selected && revision > 0 ? (
            <LiveProof
              key={scope + selected.id + revision}
              bridge={bridge}
              selection={{ ...selected, revision }}
              sourceNames={sourceNames}
              onBack={back}
            />
          ) : null}
        </Shell>
      ) : null}
    </>
  );
}
export function WorkspaceApp({ bridge = getBridge() }: { bridge?: ConnectBridge }) {
  const [status, setStatus] = useState<ConnectStatus | null>(null),
    [error, setError] = useState(""),
    [legacy, setLegacy] = useState(false);
  const [serviceUnavailable, setServiceUnavailable] = useState(false);
  const epoch = useRef(0),
    busy = useRef(false),
    displayed = useRef<ConnectStatus | null>(null);
  const refresh = useRef<() => void>(() => {}),
    followup = useRef(false);
  const accept = useCallback(
    (value: ConnectStatus) => {
      const w = value.workspace;
      const next = w
        ? {
            ...value,
            workspace: {
              ...w,
              sources: (w.sources || []).map((s) =>
                s.recognition
                  ? s
                  : {
                      ...s,
                      recognition: {
                        state: "incomplete",
                        message: "Check this source to preview its records.",
                      },
                    },
              ),
            },
          }
        : value;
      if (!next.installationId && next.enrollment?.state === "pending" && w?.step === "activate")
        followup.current = true;
      if (
        next.installationId &&
        w?.phase === "awaiting_approval" &&
        w.approvalPath &&
        followup.current &&
        bridge
      ) {
        followup.current = false;
        void bridge
          .openWorkspaceApproval()
          .catch(() => setError("Your request is ready. Open browser review to continue."));
      }
      displayed.current = next;
      setStatus(next);
      setServiceUnavailable(false);
      setError("");
    },
    [bridge],
  );
  const onBusyChange = useCallback((value: boolean) => {
    epoch.current++;
    busy.current = value;
    if (!value) refresh.current();
  }, []);
  useEffect(() => {
    if (!bridge || legacy) return;
    let stopped = false,
      polling = false,
      timer: ReturnType<typeof setTimeout>;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped) timer = setTimeout(poll, ms);
    };
    async function poll() {
      if (stopped || polling) return;
      if (busy.current) {
        schedule(500);
        return;
      }
      polling = true;
      clearTimeout(timer);
      const generation = epoch.current;
      try {
        const cur = displayed.current;
        const enrolling =
          !cur?.installationId &&
          cur?.enrollment?.state === "pending" &&
          Date.parse(cur.enrollment.expiresAt) > Date.now();
        const next = await (enrolling
          ? bridge!.pollEnrollment()
          : cur?.workspace
            ? bridge!.getWorkspaceStatus()
            : bridge!.getStatus());
        if (!stopped && generation === epoch.current) accept(next);
      } catch (e) {
        if (!stopped && generation === epoch.current) {
          setServiceUnavailable(true);
          setError(
            e instanceof Error
              ? e.message
              : "The background service is unavailable. Check the connection and try again.",
          );
        }
      } finally {
        polling = false;
        const current = displayed.current;
        const pending =
          current?.workspace?.phase === "awaiting_approval" || current?.enrollment?.state === "pending";
        if (!current || current.workspace)
          schedule(
            generation !== epoch.current
              ? 100
              : pending
                ? 1800
                : current?.workspace?.phase === "active"
                  ? 3000
                  : 10000,
          );
      }
    }
    refresh.current = () => void poll();
    const focus = () => {
      if (document.visibilityState !== "hidden") void poll();
    };
    void poll();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      epoch.current++;
      refresh.current = () => {};
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [bridge, legacy, accept]);
  if (bridge && (legacy || (status && !status.workspace)))
    return (
      <>
        {legacy && (
          <button className="secondary" onClick={() => setLegacy(false)}>
            Return to workspace
          </button>
        )}
        <ConnectApp bridge={bridge} />
      </>
    );
  return (
    <div className="pp-app">
      {(error || status?.error?.message) && (
        <div className="pp-system-notice" role="alert">
          {error || status?.error?.message}
          <button className="pp-text-button" onClick={() => refresh.current()}>
            Check connection
          </button>
        </div>
      )}
      {status?.workspace && bridge ? (
        <Experience
          status={status}
          bridge={bridge}
          accept={accept}
          onBusyChange={onBusyChange}
          onLegacy={() => setLegacy(true)}
          serviceUnavailable={serviceUnavailable}
        />
      ) : (
        <>
          <Header />
          <main className="pp-system-state">
            <h1>{bridge ? "Opening your workspace" : "Open PackProof Connect on Windows"}</h1>
            <p role="status">
              {bridge
                ? "Connecting to the background service…"
                : "Use the installed application to connect your sources."}
            </p>
          </main>
        </>
      )}
    </div>
  );
}
