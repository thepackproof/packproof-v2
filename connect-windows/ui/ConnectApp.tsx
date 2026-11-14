import { useEffect, useRef, useState } from "react";
import { SourceControls } from "./SourceControls";
import {
  GUIDED_STAGES,
  guidedStage,
  resumeStep,
  verificationCurrent,
} from "./state";
import {
  getBridge,
  type ConnectBridge,
  type ConnectStatus,
  type LocalAnalysis,
} from "./types";
const fields = [
  ["shipmentReference", "Shipment number"],
  ["itemTitle", "Contents"],
  ["quantity", "Quantity"],
  ["shippedAt", "Shipment date and time"],
  ["trackingNumber", "Tracking number"],
  ["carrier", "Carrier"],
  ["locationId", "Location"],
] as const;
const label = (field: string) =>
  fields.find(([key]) => key === field)?.[1] ?? field;
const stamp = (value?: string) =>
  value
    ? new Date(value).toLocaleString(undefined, { timeZoneName: "short" })
    : "Not reported";
const phaseText: Record<string, string> = {
  permission_review:
    "Waiting for configuration and original-file upload approval in your browser.",
  cloud_preview_pending:
    "Preserving the approved original and comparing the server interpretation.",
  batch_review: "Review the exact shipment batch in the same browser window.",
  first_import_pending:
    "Waiting for durable shipment records. Your original and receipt are preserved.",
  recurring_approval_pending:
    "Your first import is confirmed. Approve ongoing collection in your browser.",
  active: "The background service has acknowledged automatic collection.",
  needs_review: "This source needs review before collection can continue.",
  needs_retry: "Resume your saved setup request.",
};
function Shipment({
  analysis,
  uploaded = false,
}: {
  analysis: LocalAnalysis;
  uploaded?: boolean;
}) {
  const shipment = analysis.shipment as unknown as
    | Record<string, unknown>
    | undefined;
  const value = (field: string) => {
    const decision = analysis.decisions.find((d) => d.field === field);
    if (decision?.state === "missing_optional") return "Not provided";
    if (decision?.state !== "validated") return "Needs review";
    const v = shipment?.[field];
    return v === undefined || v === null
      ? "Not provided"
      : field === "shippedAt"
        ? stamp(String(v))
        : String(v);
  };
  return (
    <article className="shipment-card" aria-label="Shipment preview">
      <div className="shipment-caption">
        <span>SHIPMENT FROM YOUR REPORT</span>
        <span className="pill">
          {uploaded
            ? "Original uploaded · local interpretation"
            : "Local preview · not uploaded"}
        </span>
      </div>
      <h2>{value("shipmentReference")}</h2>
      <p className="shipment-contents">{value("itemTitle")}</p>
      <dl className="shipment-facts">
        {fields.slice(2).map(([field, name]) => (
          <div key={field}>
            <dt>{name}</dt>
            <dd>{value(field)}</dd>
          </div>
        ))}
      </dl>
      <p className="source-caption">
        {analysis.configuration.sourceContract?.historyPolicy?.initialFileName}{" "}
        · Row 2 of {analysis.rowCount} shipment{" "}
        {analysis.rowCount === 1 ? "row" : "rows"}
      </p>
    </article>
  );
}
export function ConnectApp({
  bridge = getBridge(),
}: {
  bridge?: ConnectBridge;
}) {
  const [status, setStatus] = useState<ConnectStatus | null>(null),
    [stage, setStage] = useState(0),
    [legacySetup, setLegacySetup] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [details, setDetails] = useState(false),
    [correction, setCorrection] = useState(false),
    [diagnostic, setDiagnostic] = useState(""),
    [recoveryConsent, setRecoveryConsent] = useState(false);
  const mounted = useRef(true),
    generation = useRef(0),
    inFlight = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
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
      if (nextStage !== undefined) setStage(nextStage);
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
    if (bridge) {
      setBusy("Loading your connection");
      void bridge
        .getStatus()
        .then((next) => {
          if (!mounted.current || current !== generation.current) return;
          setStatus(next);
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
  const checked = useRef(false);
  useEffect(() => {
    if (!bridge || !status || checked.current) return;
    if (typeof bridge.checkComputer !== "function") {
      checked.current = true;
      setError(
        "This app needs the matching installed background helper. Run the official installer to repair the installation.",
      );
      return;
    }
    checked.current = true;
    void bridge
      .checkComputer()
      .then((next) => {
        if (mounted.current)
          setStatus((value) =>
            value ? { ...value, checks: next.checks } : next,
          );
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
  useEffect(() => {
    heading.current?.focus();
  }, [stage]);
  // Observe the real service, with one request in flight and bounded backoff. The
  // service owns upload, exact-receipt commit and first-record verification.
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
        const current = generation.current;
        try {
          const next = status.installationId
            ? await bridge.getStatus()
            : await bridge.pollEnrollment();
          if (alive && current === generation.current) {
            setStatus(next);
            if (next.installationId && !status.installationId) setStage(0);
          }
        } catch (caught) {
          if (alive)
            setError(
              caught instanceof Error
                ? caught.message
                : "Approval status could not be checked. Reopen the saved review to continue.",
            );
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
  const disabled = !bridge || !!busy;
  const sourceHome = !!status?.capabilities?.typedSourceSubscriptions && !legacySetup;
  const compatible =
    !!analysis &&
    status?.capabilities?.rulesVersion === analysis.binding.rulesVersion;
  const blockedChecks =
    status?.checks?.filter((c) => c.state === "blocked") ?? [];
  const verified =
    !!status && verificationCurrent(status, status.config, false);
  const active =
    !!status &&
    status.state === "active" &&
    verified &&
    status.health.serviceOnline &&
    !status.pendingProposal;
  const unresolved = analysis?.decisions.find((d) =>
    ["missing_required", "incompatible", "needs_confirmation"].includes(
      d.state,
    ),
  );
  function external(operation: () => Promise<unknown>) {
    setError("");
    void operation().catch((caught) => {
      if (mounted.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "The trusted PackProof page could not be opened.",
        );
    });
  }
  async function inspectFile(name: string) {
    if (!bridge) return;
    await action(
      "Checking the complete shipment report",
      () => bridge.previewLocal(name),
      1,
    );
    setCorrection(false);
  }
  function changeColumn(field: string, column: string) {
    if (!analysis || !bridge) return;
    const mapping = { ...analysis.configuration.mapping };
    if (column) mapping[field] = column;
    else delete mapping[field];
    void action("Validating the report", () =>
      bridge.analyzeLocal({
        mapping,
        confirmedFields: (
          analysis.configuration.sourceContract?.confirmedFields ?? []
        ).filter((f) => f !== field),
      }),
    );
  }
  function confirmColumn(field: string) {
    if (!analysis || !bridge) return;
    void action("Checking the confirmed column", () =>
      bridge.analyzeLocal({
        mapping: analysis.configuration.mapping,
        confirmedFields: [
          ...new Set([
            ...(analysis.configuration.sourceContract?.confirmedFields ?? []),
            field,
          ]),
        ],
      }),
    );
  }
  return (
    <div className="connect-shell">
      <a className="connect-skip" href="#connect-content">
        Skip to setup
      </a>
      <aside className="connect-sidebar">
        <div className="connect-brand">
          <img
            src="./brand/packproof-symbol.svg"
            width="38"
            height="38"
            alt=""
          />
          <span>
            PackProof<small>CONNECT</small>
          </span>
        </div>
        <nav aria-label="Setup progress" hidden={sourceHome}>
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
        </nav>
        <div className="connect-sidebar-note">
          <strong>Your originals stay unchanged.</strong>
          <p>
            PackProof reads only the folder you select. The approved service can
            collect while this window is closed.
          </p>
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
          <span>
            {status?.binding?.sourceName ?? "Shipment connection"}
            {status?.binding?.organizationId && (
              <small>
                Workspace{" "}
                {status.binding.organizationName ?? "Approved workspace"}
              </small>
            )}
          </span>
          <button
            className="quiet"
            disabled={disabled}
            onClick={() => bridge && external(() => bridge.openPortal())}
          >
            Help
          </button>
        </header>
        <main id="connect-content" aria-busy={!!busy}>
          <div className="connect-heading">
            <span className="eyebrow">{sourceHome ? "EXISTING DATA CONNECTIONS" : `STAGE ${stage + 1} OF 3`}</span>
            <h1 ref={heading} tabIndex={-1}>
              {sourceHome ? "Your sources" : active
                ? "Your connection is active"
                : stage === 0
                  ? "Let's connect your shipment records."
                  : stage === 1
                    ? "Does this shipment look right?"
                    : "Ready to connect these shipments?"}
            </h1>
            <p>
              {sourceHome ? "Connect the existing reports that describe orders, loading and delivery. Each source keeps its own scope and approval." : active
                ? "New eligible reports are collected by the approved background service."
                : stage === 0
                  ? "Choose your shipment folder. We’ll check the report before anything is uploaded."
                  : stage === 1
                    ? "Recognize a real shipment from your report. We’ll ask only where details need review."
                    : "Review what will be uploaded, then approve the connection in your browser."}
            </p>
          </div>
          {(!bridge || error) && (
            <div role="alert" className="connect-notice blocked">
              {error ||
                "Open this setup from the installed PackProof Connect application. The secure Windows helper is unavailable."}
            </div>
          )}
          {error && !status && bridge && (
            <section className="connect-repair">
              <div>
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
              </div>
            </section>
          )}
          {status?.authorizationNotice && (
            <p className="connect-notice warning">
              {status.authorizationNotice}
            </p>
          )}
          {status?.health.lastErrorCode && (
            <p className="connect-notice warning">
              Action needed:{" "}
              {status.health.lastErrorCode.replaceAll("_", " ").toLowerCase()}.
              Pending work is preserved.
            </p>
          )}
          {status?.state === "revoked" && (
            <p role="alert" className="connect-notice blocked">
              This installation’s access was revoked. Collection is stopped.
            </p>
          )}
          {blockedChecks.length > 0 && (
            <section className="connect-card">
              <h2>The background helper needs attention.</h2>
              {blockedChecks.map((c) => (
                <p key={c.id}>{c.detail}</p>
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
            <section className="connect-card">
              <h2>Recover this installation</h2>
              <p>
                Your former queue, credentials and receipts stay preserved. Ask
                your administrator to approve this computer again. Old receipts
                cannot transfer to a new credential.
              </p>
              <label className="connect-checkbox">
                <input
                  type="checkbox"
                  checked={recoveryConsent}
                  onChange={(e) => setRecoveryConsent(e.target.checked)}
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
          {sourceHome && status && bridge && <SourceControls status={status} bridge={bridge} disabled={disabled} action={action} external={external}/>}
          {status?.capabilities?.typedSourceSubscriptions && <div className="connect-actions"><button className="quiet" disabled={disabled} onClick={() => setLegacySetup(value => !value)}>{legacySetup ? "Return to sources" : "Manage the existing shipment connection"}</button></div>}
          {!sourceHome && stage === 0 && (
            <section className="connect-card">
              {!status?.installationId ? (
                <>
                  <h2>Connect your approved workspace</h2>
                  <p>
                    Sign in in your browser and approve this computer for the
                    exact workspace, source and teammate.
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
                        className="secondary"
                        disabled={disabled}
                        onClick={() =>
                          bridge && external(() => bridge.openApproval())
                        }
                      >
                        Resume approval
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
                          Start a fresh request when you are ready.
                        </p>
                      )}
                    </>
                  )}
                </>
              ) : (
                <>
                  <h2>Choose your shipment folder</h2>
                  <p>
                    PackProof reads completed shipment reports from this folder.
                    Your originals stay unchanged.
                  </p>
                  <div className="connect-folder-choice">
                    <span className="connect-folder-symbol" aria-hidden="true">
                      ▣
                    </span>
                    <div>
                      <strong>
                        {status.source?.folder ??
                          "A local shipment export folder"}
                      </strong>
                      <p>
                        {status.source?.accessible
                          ? "Accessible to the background service"
                          : "Windows 11 · local NTFS folder · CSV reports"}
                      </p>
                    </div>
                    <button
                      className="primary"
                      disabled={disabled || blockedChecks.length > 0}
                      onClick={() =>
                        bridge &&
                        void action(
                          "Checking the selected folder",
                          async () => {
                            const next = await bridge.chooseFolder();
                            if (next.source?.files?.length === 1) {
                              const inspected = await bridge.previewLocal(
                                next.source.files[0].name,
                              );
                              setStage(1);
                              return inspected;
                            }
                            return next;
                          },
                        )
                      }
                    >
                      {status.source
                        ? "Change folder"
                        : "Choose shipment folder"}
                    </button>
                  </div>
                  {status.source && status.source.accessible && (
                    <>
                      {!status.source.files?.length ? (
                        <p className="connect-notice">
                          This folder has no completed CSV report yet. Save an
                          export here, then check again. No shipment has been
                          uploaded or created.
                        </p>
                      ) : (
                        <div className="report-list">
                          <h3>Choose a completed report</h3>
                          {status.source.files.map((f) => (
                            <button
                              className="report-choice"
                              key={f.name}
                              disabled={disabled}
                              onClick={() => void inspectFile(f.name)}
                            >
                              <strong>{f.name}</strong>
                              <span>
                                {f.byteSize.toLocaleString()} bytes
                                {f.lastWriteAt && (
                                  <small>
                                    {" "}
                                    · File updated {stamp(f.lastWriteAt)}
                                  </small>
                                )}
                              </span>
                              <span aria-hidden="true">→</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  <details className="connect-advanced">
                    <summary>Help finding your shipment reports</summary>
                    <p>
                      In your shipping or warehouse software, look for
                      Shipments, Reports or Export. Save a finished CSV in a
                      dedicated local folder that the background service can
                      read. Ask your source owner if you need help. Network
                      shares and direct database connections are not supported
                      by this connector.
                    </p>
                  </details>
                </>
              )}
            </section>
          )}
          {!sourceHome && stage === 1 && (
            <section className="connect-card">
              {analysis ? (
                <>
                  <Shipment analysis={analysis} uploaded={!!status?.preview} />
                  {analysis.issues.map((issue) => (
                    <p className="connect-notice blocked" key={issue}>
                      {issue.split(": ").slice(1).join(": ") || issue}
                    </p>
                  ))}
                  {unresolved && (
                    <section
                      className="clarification"
                      aria-label="Shipment detail requiring review"
                    >
                      <h2>
                        {unresolved.field === "shipmentReference"
                          ? "Which column identifies the shipment?"
                          : `Review ${label(unresolved.field).toLowerCase()}`}
                      </h2>
                      <p>
                        {unresolved.state === "incompatible"
                          ? "The selected column conflicts with its meaning or contains unsupported values."
                          : unresolved.state === "needs_confirmation"
                            ? "This column’s values fit, but its business meaning needs your confirmation."
                            : "Choose the column in this report, or use a different report if the detail is missing."}
                      </p>
                      {unresolved.field === "shipmentReference" && (
                        <p>
                          An order can ship more than once. An order number
                          cannot automatically identify each shipment.
                        </p>
                      )}
                      {unresolved.examples && (
                        <ul className="field-examples">
                          {Object.entries(unresolved.examples).map(
                            ([column, values]) => (
                              <li key={column}>
                                <strong>{column}:</strong> {values.join(" · ")}
                              </li>
                            ),
                          )}
                        </ul>
                      )}
                      <label>
                        {label(unresolved.field)}
                        <select
                          disabled={disabled}
                          value={unresolved.sourceColumnId ?? ""}
                          onChange={(e) =>
                            changeColumn(unresolved.field, e.target.value)
                          }
                        >
                          <option value="">
                            This report doesn’t include that
                          </option>
                          {[
                            ...new Set([
                              ...(unresolved.sourceColumnId
                                ? [unresolved.sourceColumnId]
                                : []),
                              ...unresolved.candidates,
                            ]),
                          ].map((h) => (
                            <option
                              value={h}
                              key={h}
                              disabled={!unresolved.candidates.includes(h)}
                            >
                              {h}
                            </option>
                          ))}
                        </select>
                      </label>
                      {unresolved.state === "needs_confirmation" && (
                        <button
                          className="secondary"
                          disabled={disabled}
                          onClick={() => confirmColumn(unresolved.field)}
                        >
                          This column means{" "}
                          {label(unresolved.field).toLowerCase()}
                        </button>
                      )}
                      <p className="reason">
                        {unresolved.reasonCodes
                          .join(" · ")
                          .replaceAll("_", " ")
                          .toLowerCase()}
                      </p>
                    </section>
                  )}
                  {analysis.ready && (
                    <p className="recognition-summary" role="status">
                      Required details recognized
                      {analysis.decisions.some(
                        (d) => d.state === "missing_optional",
                      )
                        ? " · optional details may be unavailable"
                        : ""}
                    </p>
                  )}
                  <div className="connect-actions">
                    <button
                      className="primary"
                      disabled={disabled || !analysis.ready}
                      onClick={() => setStage(2)}
                    >
                      Continue
                    </button>
                    <button
                      className="quiet"
                      aria-expanded={correction}
                      onClick={() => setCorrection((v) => !v)}
                    >
                      Something looks wrong
                    </button>
                  </div>
                  {!analysis.ready && (
                    <p>
                      Resolve the highlighted details to continue. You can also
                      go back and choose a different report.
                    </p>
                  )}
                  <details
                    className="connect-advanced"
                    open={correction || undefined}
                  >
                    <summary>Review all fields</summary>
                    <p>
                      Changes are rechecked against every bounded row by the
                      service. An incompatible mapping cannot be approved.
                    </p>
                    {analysis.decisions.map((d) => (
                      <label key={d.field} className="field-review">
                        {label(d.field)}
                        <select
                          disabled={disabled}
                          value={d.sourceColumnId ?? ""}
                          onChange={(e) =>
                            changeColumn(d.field, e.target.value)
                          }
                        >
                          <option value="">
                            {d.field === "locationId" &&
                            analysis.configuration.locationId
                              ? "Use approved location"
                              : "Leave unavailable"}
                          </option>
                          {[
                            ...new Set([
                              ...(d.sourceColumnId ? [d.sourceColumnId] : []),
                              ...d.candidates,
                            ]),
                          ].map((h) => (
                            <option
                              key={h}
                              value={h}
                              disabled={!d.candidates.includes(h)}
                            >
                              {h}
                            </option>
                          ))}
                        </select>
                        <small>
                          {d.state.replaceAll("_", " ")} ·{" "}
                          {d.reasonCodes
                            .join(", ")
                            .replaceAll("_", " ")
                            .toLowerCase()}
                        </small>
                      </label>
                    ))}
                  </details>
                  <details className="connect-advanced">
                    <summary>View source details</summary>
                    <dl className="connect-facts">
                      <div>
                        <dt>Original report</dt>
                        <dd>
                          {
                            analysis.configuration.sourceContract?.historyPolicy
                              ?.initialFileName
                          }
                        </dd>
                      </div>
                      <div>
                        <dt>Rows checked</dt>
                        <dd>{analysis.rowCount}</dd>
                      </div>
                      <div>
                        <dt>Original source timestamp</dt>
                        <dd>
                          {analysis.shipment?.shippedAt ?? "Needs review"}
                        </dd>
                      </div>
                      <div>
                        <dt>Date interpretation</dt>
                        <dd>
                          Each shipment’s explicit source offset is preserved.
                          No time zone is inferred.
                        </dd>
                      </div>
                    </dl>
                    <table>
                      <caption>Column provenance</caption>
                      <thead>
                        <tr>
                          <th>Shipment detail</th>
                          <th>Original column</th>
                          <th>State</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.decisions.map((d) => (
                          <tr key={d.field}>
                            <td>{label(d.field)}</td>
                            <td>
                              {d.origin === "approved_binding"
                                ? "Approved source location"
                                : (d.sourceColumnId ?? "Not provided")}
                            </td>
                            <td>{d.state.replaceAll("_", " ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                  <details className="connect-advanced">
                    <summary>Advanced source settings</summary>
                    <p>
                      Shipments dated on or after{" "}
                      {stamp(
                        analysis.configuration.sourceContract?.backfillFrom,
                      )}{" "}
                      are eligible. This boundary comes from the earliest valid
                      shipment in the selected report.
                    </p>
                    <p>
                      The initial report is imported once. Other reports already
                      present at{" "}
                      {stamp(
                        analysis.configuration.sourceContract?.historyPolicy
                          ?.observedAt,
                      )}{" "}
                      are excluded. Newly arriving CSV reports must pass this
                      same exact header, field and history contract.
                    </p>
                    <p>
                      Exporter and version:{" "}
                      {analysis.configuration.sourceContract?.exporterName ??
                        "Unknown"}{" "}
                      · Expected export cadence:{" "}
                      {analysis.configuration.sourceContract
                        ?.expectedIntervalSeconds ?? "Unknown"}
                      . The collector checks every 30 seconds while available;
                      this does not establish how often your software exports.
                    </p>
                  </details>
                </>
              ) : (
                <>
                  <h2>Choose a report to review</h2>
                  <p>
                    A validated local snapshot is required. Return to the
                    shipment folder and select a completed report.
                  </p>
                </>
              )}
            </section>
          )}
          {!sourceHome && stage === 2 && (
            <section className="connect-card">
              {active ? (
                <>
                  <div className="connection-success" aria-hidden="true">
                    ✓
                  </div>
                  <h2>Your first shipment is ready.</h2>
                  <p>
                    Approved source: {status?.config?.sourceName}. Closing this
                    window leaves the authorized service running.
                  </p>
                  <dl className="connect-facts">
                    <div>
                      <dt>Last successful collection</dt>
                      <dd>{stamp(status?.health.lastCompletedImportAt)}</dd>
                    </div>
                    <div>
                      <dt>Pending work</dt>
                      <dd>{status?.health.queueCount ?? "Not reported"}</dd>
                    </div>
                  </dl>
                  <button
                    className="primary"
                    disabled={disabled}
                    onClick={() =>
                      bridge &&
                      external(() =>
                        bridge.openRecord(status!.verification!.recordId!),
                      )
                    }
                  >
                    Open shipment records
                  </button>
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
                </>
              ) : (
                <>
                  <h2>
                    {verified
                      ? "First import confirmed"
                      : status?.setup?.running
                        ? "Complete your browser review"
                        : "Approve the exact source and upload"}
                  </h2>
                  {(analysis?.configuration ?? status?.config) && (
                    <dl className="connect-facts">
                      <div>
                        <dt>Workspace</dt>
                        <dd>
                          {status?.binding?.organizationId ??
                            "Current approved workspace"}
                        </dd>
                      </div>
                      <div>
                        <dt>Source</dt>
                        <dd>
                          {analysis?.configuration.sourceName ??
                            status?.config?.sourceName}
                        </dd>
                      </div>
                      <div>
                        <dt>Folder</dt>
                        <dd>{status?.source?.folder}</dd>
                      </div>
                      <div>
                        <dt>File pattern</dt>
                        <dd>Completed *.csv reports in this folder</dd>
                      </div>
                      <div>
                        <dt>Initial report</dt>
                        <dd>
                          {analysis?.configuration.sourceContract?.historyPolicy
                            ?.initialFileName ??
                            status?.source?.selectedFileName}
                        </dd>
                      </div>
                      <div>
                        <dt>Shipment history</dt>
                        <dd>
                          Shipments dated on or after{" "}
                          {stamp(
                            (analysis?.configuration ?? status?.config)
                              ?.sourceContract?.backfillFrom,
                          )}
                        </dd>
                      </div>
                    </dl>
                  )}
                  <p className="connect-notice">
                    The entire original report is uploaded and preserved,
                    including unmapped columns. Your originals stay unchanged.
                    After the first import is verified and recurring collection
                    is approved, new eligible reports are collected
                    automatically.
                  </p>
                  {status?.setup?.running ? (
                    <>
                      <p role="status" className="setup-progress">
                        {phaseText[status.setup.phase ?? ""] ??
                          "Waiting for the service to confirm the next step."}
                      </p>
                      <p>
                        Keep the same browser review open. Configuration, this
                        exact batch, and recurring collection each need their
                        own approval.
                      </p>
                      <button
                        className="primary"
                        disabled={disabled}
                        onClick={() =>
                          bridge && external(() => bridge.openApproval())
                        }
                      >
                        Resume approval in browser
                      </button>
                      <button
                        className="secondary"
                        disabled={disabled}
                        onClick={() =>
                          bridge &&
                          void action(
                            "Pausing setup and preserving its receipt",
                            () => bridge.pause(),
                          )
                        }
                      >
                        Pause setup
                      </button>
                    </>
                  ) : status?.pendingProposal ? (
                    <>
                      <p>
                        A saved exact configuration is waiting for approval.
                        Opening it does not upload a file or grant collection.
                      </p>
                      <button
                        className="primary"
                        disabled={disabled}
                        onClick={() =>
                          bridge && external(() => bridge.openApproval())
                        }
                      >
                        Resume saved approval
                      </button>
                    </>
                  ) : status?.state === "paused" ? (
                    <>
                      <p>
                        Automatic collection is paused. Your first record and
                        queue remain preserved.
                      </p>
                      <button
                        className="primary"
                        disabled={disabled}
                        onClick={() =>
                          bridge &&
                          void action(
                            "Requesting approved resume",
                            async () => {
                              const next = await bridge.proposeActivation();
                              await bridge.openApproval();
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
                        Resume after browser approval
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="primary"
                        disabled={
                          disabled ||
                          !analysis?.ready ||
                          !compatible ||
                          !status?.installationId ||
                          blockedChecks.length > 0
                        }
                        onClick={() =>
                          bridge &&
                          analysis &&
                          void action("Saving the exact approval request", () =>
                            bridge.startSetup({
                              wholeFileUploadApproved: true,
                              draftRevision: analysis.binding.draftRevision,
                            }),
                          )
                        }
                      >
                        Approve and connect
                      </button>
                      {analysis?.ready && !compatible && (
                        <p>
                          The server needs matching source-validation support
                          before this connection can be approved. No original
                          has been uploaded.
                        </p>
                      )}
                      {!analysis?.ready && (
                        <p>
                          Review a current shipment report before requesting
                          this approval.
                        </p>
                      )}
                    </>
                  )}
                  {status?.preview && (
                    <p>
                      Remote receipt:{" "}
                      {status.preview.state.replaceAll("_", " ")} · original
                      uploaded.{" "}
                      {verified
                        ? "A canonical record was retrieved."
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
                </>
              )}
            </section>
          )}
          <footer className="connect-footer">
            <button
              className="quiet"
              disabled={!!busy}
              onClick={() => window.close()}
            >
              Save and exit
            </button>
            {!sourceHome && stage > 0 && !active && (
              <button
                className="secondary"
                disabled={disabled || status?.setup?.running}
                onClick={() => setStage(stage - 1)}
              >
                Back
              </button>
            )}
            <button
              className="quiet"
              disabled={disabled}
              onClick={() =>
                bridge &&
                void action("Refreshing service status", () =>
                  bridge.getStatus(),
                )
              }
            >
              Refresh status
            </button>
            <details
              open={details}
              onToggle={(e) => setDetails(e.currentTarget.open)}
            >
              <summary>Support and connection details</summary>
              <p>
                Windows 11 x64 · approved local NTFS export folders · UTF-8 CSV · at most 2
                MiB, 1,000 rows and 50 columns per report. Collection pauses
                during sleep or shutdown.
              </p>
              <button
                className="secondary"
                disabled={disabled}
                onClick={() =>
                  bridge &&
                  external(async () => {
                    const result = (await bridge.exportDiagnostics()) as {
                      saved?: boolean;
                    };
                    setDiagnostic(
                      result.saved
                        ? "Redacted report saved."
                        : "Diagnostic export canceled.",
                    );
                  })
                }
              >
                Export redacted diagnostics
              </button>
              <p>{diagnostic}</p>
            </details>
            <span role="status" aria-live="polite">
              {busy || ""}
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
