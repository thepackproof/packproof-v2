import { useEffect, useRef, useState } from "react";
import { GUIDED_STAGES, guidedStage, resumeStep } from "./state";
import { deriveConnectView } from "./connect-view";
import { getBridge, type ConnectBridge, type ConnectStatus } from "./types";
import {
  label,
  stamp,
  friendlyFolder,
  ShipmentPreview,
  Facts,
  Fact,
  ApprovalJourney,
  AdvancedDrawer,
} from "./connect-components";

export function ConnectApp({
  bridge = getBridge(),
}: {
  bridge?: ConnectBridge;
}) {
  const [now, setNow] = useState(Date.now);
  const [status, setStatus] = useState<ConnectStatus | null>(null),
    [stage, setStage] = useState(0),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [drawer, setDrawer] = useState<
      "mapping" | "source" | "history" | "diagnostics" | null
    >(null),
    [correction, setCorrection] = useState(false),
    [diagnostic, setDiagnostic] = useState(""),
    [recoveryConsent, setRecoveryConsent] = useState(false),
    [analysisStale, setAnalysisStale] = useState(false),
    [allReports, setAllReports] = useState(false),
    [folderHelp, setFolderHelp] = useState(false);
  const mounted = useRef(true),
    generation = useRef(0),
    inFlight = useRef(false),
    heading = useRef<HTMLHeadingElement>(null),
    checked = useRef(false);
  const analysis = status?.analysis;
  async function action(
    message: string,
    operation: () => Promise<ConnectStatus>,
    nextStage?: number,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    const current = ++generation.current;
    setBusy(message);
    setError("");
    try {
      const next = await operation();
      if (!mounted.current || current !== generation.current) return;
      setStatus(next);
      setNow(Date.now());
      if (nextStage !== undefined) setStage(nextStage);
      return next;
    } catch (caught) {
      if (mounted.current && current === generation.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "The operation could not be confirmed. Your originals and queued work are preserved.",
        );
    } finally {
      if (mounted.current && current === generation.current) setBusy("");
      inFlight.current = false;
    }
  }
  useEffect(() => {
    mounted.current = true;
    const current = ++generation.current;
    checked.current = false;
    if (bridge) {
      setBusy("Loading your connection");
      void bridge
        .getStatus()
        .then((next) => {
          if (!mounted.current || current !== generation.current) return;
          setStatus(next);
          setNow(Date.now());
          setStage(guidedStage(resumeStep(next)));
        })
        .catch((caught) => {
          if (mounted.current)
            setError(
              caught instanceof Error
                ? caught.message
                : "The background helper is unavailable.",
            );
        })
        .finally(() => {
          if (mounted.current) setBusy("");
        });
    }
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [bridge]);
  useEffect(() => {
    if (!bridge || !status || checked.current) return;
    checked.current = true;
    if (typeof bridge.checkComputer !== "function") {
      setError(
        "Run the official installer to repair the matching background helper.",
      );
      return;
    }
    const checkGeneration = generation.current;
    void bridge
      .checkComputer()
      .then((next) => {
        if (mounted.current && checkGeneration === generation.current) {
          setNow(Date.now());
          setStatus((current) =>
            current
              ? {
                  ...current,
                  checks: next.checks,
                  transport: next.transport,
                  versions: next.versions,
                }
              : next,
          );
        }
      })
      .catch((caught) => {
        if (mounted.current)
          setError(
            caught instanceof Error
              ? caught.message
              : "The automatic computer check needs attention.",
          );
      });
  }, [bridge, !!status]);
  const view = deriveConnectView(status, analysis, status?.transport, now);
  const verified = view.prerequisites.recordVerified;
  const active = view.prerequisites.serviceAcknowledged;
  const home = view.stage === "home";
  useEffect(() => {
    heading.current?.focus();
  }, [stage, home]);
  useEffect(() => {
    if (
      !bridge ||
      !status ||
      !(
        (status.enrollment?.state === "pending" && !status.installationId) ||
        status.setup?.running
      )
    )
      return;
    let alive = true,
      timer: ReturnType<typeof setTimeout>,
      attempt = 0;
    const poll = async () => {
      if (!alive) return;
      if (!inFlight.current) {
        inFlight.current = true;
        const current = generation.current;
        try {
          const next = status.installationId
            ? await bridge.getStatus()
            : await bridge.pollEnrollment();
          if (alive && current === generation.current) {
            setStatus(next);
            setNow(Date.now());
            if (next.installationId && !status.installationId) setStage(0);
          }
        } catch (caught) {
          if (alive)
            setError(
              caught instanceof Error
                ? caught.message
                : "The saved approval status could not be checked.",
            );
        } finally {
          inFlight.current = false;
        }
      }
      if (alive)
        timer = setTimeout(
          poll,
          Math.min(30000, 6000 * 2 ** Math.min(attempt++, 3)),
        );
    };
    timer = setTimeout(poll, 6000);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    bridge,
    status?.installationId,
    status?.enrollment?.id,
    status?.enrollment?.state,
    status?.setup?.running,
  ]);
  useEffect(() => {
    const expires = Date.parse(status?.transport?.expiresAt || "");
    if (!Number.isFinite(expires) || expires <= now) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(120000, expires - now + 1),
    );
    return () => clearTimeout(timer);
  }, [status?.transport?.expiresAt, now]);
  useEffect(() => {
    if (!bridge) return;
    const recheck = () => {
      setNow(Date.now());
      const expires = Date.parse(status?.transport?.expiresAt || "");
      if (
        document.visibilityState !== "hidden" &&
        (!Number.isFinite(expires) || expires <= Date.now()) &&
        !inFlight.current
      ) {
        void action("Rechecking connection after returning", async () => {
          const next = await bridge.checkComputer();
          setNow(Date.now());
          return next;
        });
      }
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [bridge, status?.transport?.expiresAt]);
  const disabled = !bridge || !!busy;
  const blockedChecks =
    status?.checks?.filter((check) => check.state === "blocked") ?? [];
  const unresolved = analysis?.decisions.find((d) =>
    ["missing_required", "incompatible", "needs_confirmation"].includes(
      d.state,
    ),
  );
  const config = analysis?.configuration ?? status?.config;
  const uploaded = !!status?.preview;
  const sourceContract = config?.sourceContract;
  const localReady = view.prerequisites.localReady && !analysisStale;
  const approvalPending = !!status?.setup?.running || !!status?.pendingProposal;
  function external(operation: () => Promise<unknown>) {
    setError("");
    void operation().catch((caught) => {
      if (mounted.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "The trusted PackProof review could not be opened. Your saved request is preserved.",
        );
    });
  }
  async function inspectFile(name: string) {
    if (!bridge) return;
    setAnalysisStale(true);
    const next = await action(
      "Checking the complete shipment report",
      () => bridge.previewLocal(name),
      1,
    );
    if (next?.analysis) {
      setAnalysisStale(false);
      setCorrection(false);
    }
  }
  async function chooseFolder() {
    if (!bridge) return;
    setAnalysisStale(true);
    setAllReports(false);
    const next = await action("Checking the selected folder", async () => {
      const picked = await bridge.chooseFolder();
      if (picked.source?.accessible && picked.source.files?.length === 1) {
        const inspected = await bridge.previewLocal(
          picked.source.files[0].name,
        );
        setStage(1);
        return inspected;
      }
      return picked;
    });
    if (next?.analysis) setAnalysisStale(false);
  }
  async function reanalyze(field: string, column?: string, confirm = false) {
    if (!analysis || !bridge) return;
    setAnalysisStale(true);
    setStage(1);
    const mapping = { ...analysis.configuration.mapping };
    if (column !== undefined) {
      if (column) mapping[field] = column;
      else delete mapping[field];
    }
    const confirmedFields = (
      analysis.configuration.sourceContract?.confirmedFields ?? []
    ).filter((f) => f !== field);
    if (confirm) confirmedFields.push(field);
    const next = await action("Rechecking every shipment in the report", () =>
      bridge.analyzeLocal({ mapping, confirmedFields }),
    );
    if (next?.analysis) setAnalysisStale(false);
  }
  function diagnostics() {
    if (!bridge) return;
    external(async () => {
      const result = (await bridge.exportDiagnostics()) as { saved?: boolean };
      setDiagnostic(
        result?.saved
          ? "Redacted report saved. Choose whether to share it."
          : "Diagnostic export canceled.",
      );
    });
  }
  function refresh() {
    if (bridge)
      void action("Checking the live connection", async () => {
        const next = await bridge.refresh();
        setNow(Date.now());
        return next;
      });
  }
  const title = home
    ? view.title
    : stage === 0
      ? "Where does your warehouse save shipment reports?"
      : stage === 1
        ? "We found your shipments."
        : "Ready to connect your shipments?";
  const subtitle = home
    ? "Review source activity and the last completed import."
    : stage === 0
      ? "Choose the folder your software already uses. PackProof will check a completed report locally before uploading anything."
      : stage === 1
        ? "Here’s an example from your report. Is this the shipment you expected?"
        : "Review what PackProof will access, then complete the permissions in your browser.";
  return (
    <div className="connect-shell">
      <a className="connect-skip" href="#connect-content">
        Skip to setup
      </a>
      <aside className="connect-sidebar">
        <div className="connect-brand">
          <img
            src="./brand/packproof-symbol.svg"
            width="36"
            height="36"
            alt=""
          />
          <span>
            PackProof<small>CONNECT</small>
          </span>
        </div>
        <nav aria-label={home ? "Source navigation" : "Setup progress"}>
          {home ? (
            <p className="source-nav">
              <span aria-hidden="true">▤</span> Shipments
            </p>
          ) : (
            <ol>
              {GUIDED_STAGES.map((name, index) => (
                <li
                  key={name}
                  aria-current={stage === index ? "step" : undefined}
                  className={stage > index ? "completed" : ""}
                >
                  <span aria-hidden="true">
                    {stage > index ? "✓" : index + 1}
                  </span>
                  {name}
                </li>
              ))}
            </ol>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button className="quiet" onClick={() => setDrawer("diagnostics")}>
            Advanced settings
          </button>
          <small>
            {status?.installedVersion
              ? `Version ${status.installedVersion}`
              : "Version not reported"}{" "}
            · {status?.environment ?? "Environment not confirmed"}
          </small>
        </div>
      </aside>
      <div className="connect-workspace">
        <header className="connect-topbar">
          <div>
            <strong>
              {status?.binding?.organizationName || "Shipment workspace"}
            </strong>
            <small>
              {status?.binding?.sourceName || "Local shipment exports"}
            </small>
          </div>
          <div className="topbar-actions">
            <span className="connection-indicator">
              {view.problem?.kind === "network"
                ? "Offline — local review available"
                : status?.health.serviceOnline
                  ? "Background helper available"
                  : "Helper not confirmed"}
            </span>
            <button className="quiet" onClick={() => setDrawer("diagnostics")}>
              Settings
            </button>
            <button
              className="quiet"
              onClick={() => setFolderHelp((value) => !value)}
              aria-expanded={folderHelp}
            >
              Help
            </button>
          </div>
        </header>
        <main id="connect-content" aria-busy={!!busy}>
          <div className="connect-heading">
            <span className="eyebrow">
              {home ? "SOURCE OVERVIEW" : `STEP ${stage + 1} OF 3`}
            </span>
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
            <p>{subtitle}</p>
          </div>
          {(!bridge || error) && (
            <div role="alert" className="connect-notice blocked">
              {error ||
                "Open this setup from the installed PackProof Connect application. The secure Windows helper is unavailable."}
            </div>
          )}
          {error && !status && bridge && (
            <section className="connect-repair">
              <h2>The background helper needs attention.</h2>
              <p>
                Run the official PackProof Connect installer to repair the
                helper. Keep the protected data folder and queued work.
              </p>
              <button
                className="secondary"
                disabled={disabled}
                onClick={() =>
                  void action("Checking the background helper", () =>
                    bridge.getStatus(),
                  )
                }
              >
                Check again
              </button>
            </section>
          )}
          {folderHelp && (
            <aside className="connect-notice">
              <strong>Find your existing export folder</strong>
              <p>
                In your warehouse software, look for Shipments, Reports or
                Export. Ask the source owner for the local folder used for
                completed UTF-8 CSV exports. Network shares and direct database
                connections are not supported by this connector. Choosing a
                folder does not configure your warehouse exporter.
              </p>
              <button className="quiet" onClick={() => setFolderHelp(false)}>
                Close help
              </button>
            </aside>
          )}
          {status?.authorizationNotice && (
            <p className="connect-notice warning">
              {status.authorizationNotice}
            </p>
          )}
          {status?.state === "revoked" && (
            <p role="alert" className="connect-notice blocked">
              This installation’s access was revoked. Collection is stopped. Ask
              your administrator to authorize recovery.
            </p>
          )}
          {blockedChecks.length > 0 && (
            <section className="connect-repair">
              <h2>The background helper needs attention.</h2>
              {blockedChecks.map((check) => (
                <p key={check.id}>{check.detail}</p>
              ))}
              <button
                className="secondary"
                disabled={disabled}
                onClick={() =>
                  bridge &&
                  void action("Checking this computer", () =>
                    bridge.checkComputer(),
                  )
                }
              >
                Check again
              </button>
            </section>
          )}
          {status?.recoveryAvailable && (
            <section className="connect-card recovery-card">
              <h2>Recover this installation</h2>
              <p>
                Your former queue, credentials and receipts stay preserved. Ask
                your administrator to approve this computer again. Old receipts
                cannot transfer to a new credential.
              </p>
              <label className="connect-checkbox">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={recoveryConsent}
                  onChange={(event) => setRecoveryConsent(event.target.checked)}
                />
                Preserve former pending work and begin new browser approval.
              </label>
              <button
                className="secondary"
                disabled={disabled || !recoveryConsent}
                onClick={() =>
                  bridge &&
                  void action(
                    "Preserving work for recovery",
                    () =>
                      bridge.recoverEnrollment({
                        preservePendingWorkApproved: true,
                      }),
                    0,
                  )
                }
              >
                Begin approved recovery
              </button>
            </section>
          )}
          {home && status ? (
            <div className="screen-grid">
              <section className="connect-card">
                <div className="card-title">
                  <h2>Shipments</h2>
                  <span className={`state-pill ${active ? "success" : ""}`}>
                    {view.stage === "home"
                      ? view.connectionState
                      : "Needs attention"}
                  </span>
                </div>
                <h3>
                  {status.config?.sourceName || "Approved shipment source"}
                </h3>
                <p className="source-caption">
                  {friendlyFolder(status.source?.folder)}
                </p>
                <Facts>
                  <Fact name="Latest source shipment time">
                    {stamp(status.health.sourceWatermarkAt)}
                  </Fact>
                  <Fact name="Last file observed (this computer)">
                    {stamp(status.health.lastExportAt)}
                  </Fact>
                  <Fact name="Last completed import (server)">
                    {stamp(status.health.lastCompletedImportAt)}
                  </Fact>
                  <Fact name="Pending files">
                    {status.health.queueCount ?? "Not reported"}
                  </Fact>
                  <Fact name="Source freshness">
                    {status.health.sourceFreshness === "current"
                      ? "Current source result"
                      : status.health.sourceFreshness === "delayed"
                        ? "No recent export detected"
                        : "Unknown — exporter cadence not established"}
                  </Fact>
                </Facts>
                <div className="metric-strip">
                  <div>
                    <strong>
                      {status.health.sourceAccounting?.acceptedRows ?? "—"}
                    </strong>
                    <span>Accepted rows</span>
                  </div>
                  <div>
                    <strong>
                      {status.health.sourceAccounting?.rejectedRows ?? "—"}
                    </strong>
                    <span>Rejected rows</span>
                  </div>
                  <div>
                    <strong>
                      {status.health.sourceAccounting?.pendingRows ?? "—"}
                    </strong>
                    <span>Pending rows</span>
                  </div>
                </div>
                {!active && (
                  <p className="connect-notice warning">
                    {status.state === "paused"
                      ? "Collection is paused. Pending work remains preserved. Resume requires current browser approval."
                      : "Active collection is not confirmed. Test the connection to check current permission and service status."}
                  </p>
                )}
                <div className="connect-actions">
                  <button
                    className="primary"
                    disabled={disabled || !verified}
                    onClick={() =>
                      bridge &&
                      status.verification?.recordId &&
                      external(() =>
                        bridge.openRecord(status.verification!.recordId!),
                      )
                    }
                  >
                    Open shipment records
                  </button>
                  <button
                    className="secondary"
                    disabled={disabled}
                    onClick={refresh}
                  >
                    Test connection
                  </button>
                  {active ? (
                    <button
                      className="secondary"
                      disabled={disabled}
                      onClick={() =>
                        bridge &&
                        void action("Pausing new collection", () =>
                          bridge.pause(),
                        )
                      }
                    >
                      Pause collection
                    </button>
                  ) : (
                    status.state === "paused" && (
                      <>
                        <button
                          className="secondary"
                          disabled={disabled}
                          onClick={() =>
                            bridge &&
                            void action(
                              "Requesting approved resume",
                              async () => {
                                const next = await bridge.proposeActivation();
                                try {
                                  await bridge.openApproval();
                                } catch {
                                  setError(
                                    "Your resume request is saved. Select Continue review in browser to reopen it.",
                                  );
                                }
                                return next;
                              },
                            )
                          }
                        >
                          Review resume in browser
                        </button>
                        <button
                          className="secondary"
                          disabled={disabled}
                          onClick={() =>
                            bridge &&
                            void action("Checking approved resume", () =>
                              bridge.resume(),
                            )
                          }
                        >
                          Check approved resume
                        </button>
                        {status.approvalPath && (
                          <button
                            className="quiet"
                            disabled={disabled}
                            onClick={() =>
                              bridge && external(() => bridge.openApproval())
                            }
                          >
                            Continue review in browser
                          </button>
                        )}
                      </>
                    )
                  )}
                </div>
              </section>
              <aside className="connect-card supporting-card">
                <h2>One source, one clear record</h2>
                <p>
                  The background service, report exporter and completed imports
                  are measured separately.
                </p>
                <p>
                  Closing this window leaves approved collection available while
                  the service and source are running.
                </p>
                <button className="quiet" onClick={() => setDrawer("source")}>
                  View source details
                </button>
              </aside>
            </div>
          ) : stage === 0 ? (
            <div className="screen-grid">
              <section className="connect-card">
                {!status?.installationId ? (
                  <>
                    <span className="card-kicker">YOUR WORKSPACE</span>
                    <h2>Connect your approved workspace</h2>
                    <p>
                      Sign in in your browser and approve this computer for the
                      exact workspace and source.
                    </p>
                    {status?.enrollment?.state === "pending" ? (
                      <>
                        <div className="connect-comparison">
                          <span>Compare this code with your browser</span>
                          <strong>{status.enrollment.comparisonCode}</strong>
                          <p>Expires {stamp(status.enrollment.expiresAt)}</p>
                        </div>
                        <p role="status">
                          Waiting for browser approval. This window checks
                          automatically.
                        </p>
                        <button
                          className="primary"
                          disabled={disabled}
                          onClick={() =>
                            bridge && external(() => bridge.openApproval())
                          }
                        >
                          Continue workspace approval
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="primary"
                          disabled={
                            disabled ||
                            !status?.health.serviceOnline ||
                            blockedChecks.length > 0
                          }
                          onClick={() =>
                            bridge &&
                            void action("Opening browser approval", () =>
                              bridge.beginEnrollment(),
                            )
                          }
                        >
                          Sign in and approve this computer
                        </button>
                        {status?.enrollment && (
                          <p>
                            {status.enrollment.state === "denied"
                              ? "Approval was denied."
                              : "This approval expired."}{" "}
                            Start a fresh request when ready.
                          </p>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <span className="card-kicker">SHIPMENT SOURCE</span>
                    <h2>Choose your shipment folder</h2>
                    <div className="connect-folder-choice">
                      <span
                        className="connect-folder-symbol"
                        aria-hidden="true"
                      >
                        ▣
                      </span>
                      <div>
                        <strong>
                          {status.source?.folder ||
                            "Your completed CSV export folder"}
                        </strong>
                        <p>
                          {status.source?.accessible
                            ? "✓ Readable by background service"
                            : "Windows 11 · local NTFS folder · CSV reports"}
                        </p>
                      </div>
                      <button
                        className={status.source ? "secondary" : "primary"}
                        disabled={disabled || blockedChecks.length > 0}
                        onClick={() => void chooseFolder()}
                      >
                        {status.source
                          ? "Change folder"
                          : "Choose shipment folder"}
                      </button>
                    </div>
                    {status.source && !status.source.accessible && (
                      <p className="connect-notice warning">
                        PackProof cannot read this folder. Choose an approved
                        local folder or ask the source owner to check its
                        service access.
                      </p>
                    )}
                    {status.source?.accessible &&
                      (!status.source.files?.length ? (
                        <div className="empty-source">
                          <h3>No completed report found</h3>
                          <p>
                            Configure your existing exporter to save a completed
                            CSV here. Copying one file does not arrange future
                            exports.
                          </p>
                          <button
                            className="secondary"
                            disabled={disabled}
                            onClick={refresh}
                          >
                            Check folder again
                          </button>
                        </div>
                      ) : (
                        <div className="report-list">
                          <h3>Choose a completed report</h3>
                          {[...status.source.files]
                            .sort((a, b) =>
                              (b.lastWriteAt || "").localeCompare(
                                a.lastWriteAt || "",
                              ),
                            )
                            .slice(0, allReports ? undefined : 5)
                            .map((file) => (
                              <button
                                className="report-choice"
                                key={file.name}
                                disabled={disabled}
                                onClick={() => void inspectFile(file.name)}
                              >
                                <span>
                                  <strong>{file.name}</strong>
                                  <small>
                                    {file.lastWriteAt
                                      ? `Updated ${stamp(file.lastWriteAt)}`
                                      : `${file.byteSize.toLocaleString()} bytes`}
                                  </small>
                                </span>
                                <span aria-hidden="true">→</span>
                              </button>
                            ))}
                          {status.source.files.length > 5 && (
                            <button
                              className="quiet"
                              onClick={() => setAllReports((value) => !value)}
                            >
                              {allReports
                                ? "Show recent reports"
                                : "View all reports"}
                            </button>
                          )}
                        </div>
                      ))}
                    <button
                      className="quiet"
                      onClick={() => setFolderHelp((value) => !value)}
                    >
                      How do I find my export folder?
                    </button>
                  </>
                )}
              </section>
              <aside className="connect-card supporting-card">
                <div className="support-icon" aria-hidden="true">
                  ▤
                </div>
                <h2>Use the reports you already have</h2>
                <p>
                  Your warehouse software publishes the CSV. PackProof checks a
                  real shipment and keeps the original unchanged.
                </p>
                <p className="quiet-copy">
                  Nothing is uploaded during local review.
                </p>
                <button className="quiet" onClick={() => setDrawer("history")}>
                  View supported source requirements
                </button>
              </aside>
            </div>
          ) : stage === 1 ? (
            <div className="screen-grid">
              <section className="connect-card">
                {analysis ? (
                  <>
                    <ShipmentPreview analysis={analysis} uploaded={uploaded} />
                    {unresolved ? (
                      <div className="clarification">
                        <h3>Review {label(unresolved.field).toLowerCase()}</h3>
                        <p>
                          {unresolved.state === "needs_confirmation"
                            ? `Does “${unresolved.sourceColumnId}” contain the ${label(unresolved.field).toLowerCase()}?`
                            : `Choose the column containing a real ${label(unresolved.field).toLowerCase()}.`}
                        </p>
                        {unresolved.examples &&
                          Object.entries(unresolved.examples).map(
                            ([column, values]) => (
                              <p key={column} className="sample-values">
                                <strong>{column}:</strong> {values.join(" · ")}
                              </p>
                            ),
                          )}
                        {unresolved.state === "needs_confirmation" && (
                          <button
                            className="secondary"
                            disabled={disabled}
                            onClick={() =>
                              void reanalyze(unresolved.field, undefined, true)
                            }
                          >
                            Yes, confirm this meaning
                          </button>
                        )}
                        <button
                          className="quiet"
                          onClick={() => {
                            setCorrection(true);
                            setDrawer("mapping");
                          }}
                        >
                          Choose a different column
                        </button>
                      </div>
                    ) : analysis.ready ? (
                      <p className="recognition-summary">
                        ✓ Required shipment details recognized
                      </p>
                    ) : (
                      <p className="connect-notice warning">
                        This report needs attention before continuing.
                      </p>
                    )}
                    {analysis.issues.length > 0 && (
                      <div className="connect-notice warning">
                        <strong>Report checks need attention</strong>
                        <ul>
                          {analysis.issues.map((issue, index) => (
                            <li key={index}>
                              {issue
                                .replaceAll("_", " ")
                                .replace(/^./, (value) => value.toUpperCase())}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {analysisStale && (
                      <p className="connect-notice warning">
                        The report or mapping changed. A successful full local
                        check is required before continuing.
                      </p>
                    )}
                    <div className="connect-actions">
                      <button
                        className="primary"
                        disabled={disabled || !localReady}
                        onClick={() => setStage(2)}
                      >
                        Yes, this looks right
                      </button>
                      <button
                        className="secondary"
                        disabled={disabled}
                        onClick={() => {
                          setCorrection(true);
                          setDrawer("mapping");
                        }}
                      >
                        Something looks wrong
                      </button>
                    </div>
                    <button
                      className="quiet"
                      onClick={() => setDrawer("source")}
                    >
                      View report details
                    </button>
                  </>
                ) : (
                  <>
                    <h2>Choose a report to review</h2>
                    <p>
                      A current local snapshot is required. Choose a completed
                      report from your shipment folder.
                    </p>
                    <button className="primary" onClick={() => setStage(0)}>
                      Choose a different report
                    </button>
                  </>
                )}
              </section>
              <aside className="connect-card supporting-card">
                <h2>Recognize your shipment</h2>
                <p>
                  Check the reference, contents, quantity and original source
                  date. Missing optional details stay unavailable.
                </p>
                <p className="quiet-copy">
                  Confirming this preview does not upload a file or grant
                  collection permission.
                </p>
                <button
                  className="quiet"
                  disabled={disabled}
                  onClick={() => setStage(0)}
                >
                  Choose a different report
                </button>
              </aside>
            </div>
          ) : (
            <div className="screen-grid">
              <section className="connect-card">
                <span className="card-kicker">ACCESS SUMMARY</span>
                <h2>
                  {approvalPending
                    ? "Complete your browser review"
                    : "Your source and first upload"}
                </h2>
                <Facts>
                  <Fact name="Source">
                    {config?.sourceName || "Review a shipment first"}
                    <small>
                      {friendlyFolder(status?.source?.folder)} ·{" "}
                      {status?.binding?.organizationName ||
                        "Approved workspace"}
                    </small>
                  </Fact>
                  <Fact name="First upload">
                    {sourceContract?.historyPolicy?.initialFileName ||
                      status?.source?.selectedFileName ||
                      "No report selected"}
                  </Fact>
                  <Fact name="History boundary">
                    {sourceContract?.backfillFrom || "Not established"}
                    <small>
                      Other existing files are excluded unless separately
                      approved.
                    </small>
                  </Fact>
                </Facts>
                <p className="scope-notice">
                  The whole original file, including unmapped columns, will be
                  preserved.
                </p>
                <p>
                  After separate approval, newly completed eligible CSV exports
                  in this folder will be collected automatically while the
                  background service is available.
                </p>
                {approvalPending && status ? (
                  <>
                    <ApprovalJourney status={status} phases={view.phases} />
                    <div className="connect-actions">
                      <button
                        className="primary"
                        disabled={disabled}
                        onClick={() =>
                          bridge && external(() => bridge.openApproval())
                        }
                      >
                        Continue review in browser
                      </button>
                      <button
                        className="secondary"
                        disabled={disabled}
                        onClick={refresh}
                      >
                        I’ve finished — check status
                      </button>
                    </div>
                    <p className="source-caption">
                      The secure review opens on the PackProof site configured
                      for this installation. Sign-in returns to this exact
                      installation and import review.
                    </p>
                  </>
                ) : (
                  <>
                    <button
                      className="primary"
                      disabled={
                        disabled ||
                        !localReady ||
                        !!view.ctaDisabledReason ||
                        !status?.installationId
                      }
                      onClick={() =>
                        bridge &&
                        analysis &&
                        void action("Saving the exact source review", () =>
                          bridge.startSetup({
                            wholeFileUploadApproved: true,
                            draftRevision: analysis.binding.draftRevision,
                          }),
                        )
                      }
                    >
                      Review permissions in browser
                    </button>
                    {!localReady && (
                      <p className="connect-notice warning">
                        Review a current shipment report before requesting
                        permission.
                      </p>
                    )}
                    {view.problem && (
                      <div className="connect-notice warning">
                        <strong>{view.problem.title}</strong>
                        <p>{view.problem.message}</p>
                        <div className="connect-actions">
                          <button
                            className="secondary"
                            disabled={disabled}
                            onClick={refresh}
                          >
                            Retry connection
                          </button>
                          <button
                            className="quiet"
                            onClick={() => setDrawer("diagnostics")}
                          >
                            Technical details
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {uploaded && (
                  <p className="source-caption">
                    Original uploaded · receipt{" "}
                    {status?.preview?.state.replaceAll("_", " ")}.{" "}
                    {verified
                      ? "The canonical shipment record was retrieved."
                      : "Record creation has not yet been confirmed."}
                  </p>
                )}
                {verified && (
                  <button
                    className="quiet"
                    disabled={disabled}
                    onClick={() =>
                      bridge &&
                      external(() =>
                        bridge.openRecord(status!.verification!.recordId!),
                      )
                    }
                  >
                    Open first shipment
                  </button>
                )}
                <button className="quiet" onClick={() => setDrawer("history")}>
                  Review full access details
                </button>
              </section>
              <aside className="connect-card supporting-card">
                <h2>Three explicit permissions</h2>
                <ol className="permission-list">
                  <li>Review source access and the initial original</li>
                  <li>Review the exact shipment batch</li>
                  <li>
                    Approve ongoing collection after the first record is
                    verified
                  </li>
                </ol>
                <p className="quiet-copy">
                  Signing in alone does not connect your source.
                </p>
              </aside>
            </div>
          )}
          <footer className="connect-footer">
            {stage > 0 && !home && (
              <button
                className="secondary"
                disabled={disabled || approvalPending}
                onClick={() => setStage(stage - 1)}
              >
                Back
              </button>
            )}
            <button
              className="quiet"
              disabled={!!busy}
              onClick={() => window.close()}
            >
              Save and exit
            </button>
            <button className="quiet" disabled={disabled} onClick={refresh}>
              Refresh status
            </button>
            <span role="status" aria-live="polite">
              {busy || ""}
            </span>
          </footer>
        </main>
      </div>
      {drawer && (
        <AdvancedDrawer
          title={
            correction && drawer === "mapping"
              ? "Review shipment details"
              : "Advanced details"
          }
          onClose={() => {
            setDrawer(null);
            setCorrection(false);
          }}
        >
          <div className="drawer-tabs" aria-label="Advanced sections">
            {(
              [
                ["mapping", "Field mapping"],
                ["source", "Original source"],
                ["history", "History & scope"],
                ["diagnostics", "Diagnostics"],
              ] as const
            ).map(([key, name]) => (
              <button
                key={key}
                className={drawer === key ? "selected" : "quiet"}
                aria-pressed={drawer === key}
                onClick={() => setDrawer(key)}
              >
                {name}
              </button>
            ))}
          </div>
          {drawer === "mapping" ? (
            <>
              <h3>
                {correction ? "Correct the affected fields" : "Field mapping"}
              </h3>
              <p>
                Every change rechecks all bounded original rows. The previous
                preview cannot be approved while revalidation is incomplete.
              </p>
              {analysis ? (
                (correction && unresolved
                  ? [
                      unresolved,
                      ...analysis.decisions.filter(
                        (d) => d.field !== unresolved.field,
                      ),
                    ]
                  : analysis.decisions
                ).map((decision) => (
                  <div key={decision.field} className="field-review">
                    <label>
                      {label(decision.field)}
                      <select
                        disabled={disabled}
                        value={decision.sourceColumnId ?? ""}
                        onChange={(event) =>
                          void reanalyze(decision.field, event.target.value)
                        }
                      >
                        <option value="">
                          {decision.origin === "approved_binding"
                            ? "Use approved source location"
                            : "Not provided"}
                        </option>
                        {[
                          ...new Set([
                            ...(decision.sourceColumnId
                              ? [decision.sourceColumnId]
                              : []),
                            ...decision.candidates,
                          ]),
                        ].map((column) => (
                          <option
                            key={column}
                            value={column}
                            disabled={!decision.candidates.includes(column)}
                          >
                            {column}
                          </option>
                        ))}
                      </select>
                    </label>
                    <small>
                      {decision.state.replaceAll("_", " ")}
                      {decision.reasonCodes.length
                        ? ` · ${decision.reasonCodes.join(", ").replaceAll("_", " ").toLowerCase()}`
                        : ""}
                    </small>
                    {decision.state === "needs_confirmation" && (
                      <button
                        className="quiet"
                        disabled={disabled}
                        onClick={() =>
                          void reanalyze(decision.field, undefined, true)
                        }
                      >
                        Confirm {label(decision.field).toLowerCase()} meaning
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p>Choose a completed report to inspect its fields.</p>
              )}
              <button
                className="secondary"
                disabled={disabled || approvalPending}
                onClick={() => {
                  setStage(0);
                  setDrawer(null);
                }}
              >
                Choose a different report
              </button>
            </>
          ) : drawer === "source" ? (
            <>
              <h3>Original source</h3>
              <Facts>
                <Fact name="Folder">{status?.source?.folder}</Fact>
                <Fact name="Original report">
                  {sourceContract?.historyPolicy?.initialFileName ||
                    status?.source?.selectedFileName}
                </Fact>
                <Fact name="Rows checked">{analysis?.rowCount}</Fact>
                <Fact name="Original source timestamp">
                  {analysis?.shipment?.shippedAt}
                </Fact>
                <Fact name="Date interpretation">
                  Each explicit source offset is preserved. No time zone is
                  inferred.
                </Fact>
                <Fact name="Exporter">
                  {sourceContract?.exporterName || "Unknown"}
                </Fact>
                <Fact name="Exporter version">
                  {sourceContract?.exporterVersion || "Unknown"}
                </Fact>
                <Fact name="Original SHA-256">
                  {analysis?.binding.fileSha256 || status?.source?.fileSha256}
                </Fact>
                <Fact name="Exact headers">
                  {analysis?.headers.join(" · ")}
                </Fact>
              </Facts>
              {analysis && (
                <table>
                  <caption>Column provenance</caption>
                  <thead>
                    <tr>
                      <th>Shipment detail</th>
                      <th>Original column</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.decisions.map((decision) => (
                      <tr key={decision.field}>
                        <td>{label(decision.field)}</td>
                        <td>
                          {decision.origin === "approved_binding"
                            ? "Approved source location"
                            : decision.sourceColumnId || "Not provided"}
                        </td>
                        <td>{decision.state.replaceAll("_", " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : drawer === "history" ? (
            <>
              <h3>History and collection scope</h3>
              <p>
                Windows 11 x64 · one local NTFS folder · UTF-8 CSV · at most 2
                MiB, 1,000 rows and 50 columns per report.
              </p>
              <Facts>
                <Fact name="First eligible shipment date">
                  {sourceContract?.backfillFrom}
                </Fact>
                <Fact name="Existing-file baseline">
                  {stamp(sourceContract?.historyPolicy?.observedAt)}
                </Fact>
                <Fact name="Baseline SHA-256">
                  {sourceContract?.historyPolicy?.baselineSha256}
                </Fact>
                <Fact name="Export cadence">
                  {sourceContract?.expectedIntervalSeconds
                    ? `${sourceContract.expectedIntervalSeconds} seconds`
                    : "Unknown"}
                </Fact>
                <Fact name="Offline authorization window">
                  {config?.offlineWindowHours
                    ? `${config.offlineWindowHours} hours`
                    : "Not established"}
                </Fact>
              </Facts>
              <p>
                The selected original is imported once after explicit approval.
                Other reports already present at the recorded baseline are
                excluded. Only newly completed eligible reports are considered
                after separate recurring approval.
              </p>
              <p>
                Service polling does not establish your exporter’s cadence.
                Reads stop after the authorized offline window or if the clock
                is uncertain. A disconnected computer learns remote revocation
                when it reconnects.
              </p>
            </>
          ) : (
            <>
              <h3>Connection compatibility</h3>
              <Facts>
                <Fact name="Service version">
                  {status?.versions?.service || "Not reported"}
                </Fact>
                <Fact name="Bridge protocol">
                  {status?.versions?.bridgeProtocol ?? "Not reported"}
                </Fact>
                <Fact name="Last connection attempt">
                  {stamp(status?.transport?.attemptedAt)}
                </Fact>
                <Fact name="Last successful connection">
                  {stamp(status?.transport?.succeededAt)}
                </Fact>
                <Fact name="Connection classification">
                  {status?.transport?.state || "Unknown"}
                </Fact>
                <Fact name="Failure category">
                  {status?.transport?.failureKind || "None reported"}
                </Fact>
                <Fact name="Request correlation">
                  {status?.transport?.correlationId || "Not reported"}
                </Fact>
                <Fact name="App version">
                  {status?.installedVersion || "Not reported"}
                </Fact>
                <Fact name="Environment">{status?.environment}</Fact>
                <Fact name="Background helper">
                  {status?.health.serviceOnline ? "Available" : "Not confirmed"}
                </Fact>
                <Fact name="Expected CSV rules">
                  {analysis?.binding.rulesVersion}
                </Fact>
                <Fact name="Reported API rules">
                  {status?.capabilities?.rulesVersion || "Not reported"}
                </Fact>
                <Fact name="Reported source contracts">
                  {status?.capabilities?.sourceContracts.join(" · ") ||
                    "Not reported"}
                </Fact>
                <Fact name="Semantic profile">
                  {analysis?.binding.profileVersion}
                </Fact>
                <Fact name="Last folder check">
                  {stamp(status?.health.lastScanAt)}
                </Fact>
                <Fact name="Last receipt reconciliation">
                  {stamp(status?.health.lastReceiptReconciledAt)}
                </Fact>
                <Fact name="Pending files">
                  {status?.health.queueCount ?? "Not reported"}
                </Fact>
                <Fact name="Historical diagnostic code">
                  {status?.health.lastErrorCode || "None reported"}
                </Fact>
              </Facts>
              <p>
                Historical errors do not prove a current outage. Test the live
                connection before retrying approval. Diagnostics exclude
                credentials, customer rows and source paths by default.
              </p>
              <div className="connect-actions">
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={refresh}
                >
                  Test connection
                </button>
                <button
                  className="secondary"
                  disabled={disabled}
                  onClick={diagnostics}
                >
                  Export redacted diagnostics
                </button>
              </div>
              <p role="status">{diagnostic}</p>
            </>
          )}
        </AdvancedDrawer>
      )}
    </div>
  );
}
