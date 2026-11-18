import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConnectStatus } from "../types";
import type {
  DraftPreview,
  OrderSummary,
  SourceRole,
  WorkspaceBridge,
  WorkspaceSource,
  WorkspaceStep,
} from "../workspace-types";
import {
  Context,
  Progress,
  Row,
  SetupDialog,
  WelcomeExample,
  eligible,
  kindNames,
  roles,
  shortFolder,
  sourceName,
} from "./SetupParts";
import "./Setup.css";

type Stage =
  | "welcome"
  | "start"
  | "software"
  | "softwareChoice"
  | "files"
  | "discover"
  | "checked"
  | "first"
  | "output"
  | "activate"
  | "done";
type Example = DraftPreview["examples"][number];
interface Props {
  status: ConnectStatus;
  bridge: WorkspaceBridge;
  onStatus: (s: ConnectStatus) => void;
  onComplete: () => void;
  onSample: () => void;
  onOpenProof?: (order: OrderSummary) => void;
  onOpenDraftProof?: (example: Example) => void;
  onBusyChange?: (busy: boolean) => void;
  onLegacy?: () => void;
}
const providers = [
  ["Shopify", "Online store", "storefront"],
  ["Microsoft Dynamics 365", "Business system", "computer"],
  ["NetSuite", "Order management", "records"],
  ["SAP", "Enterprise system", "layers"],
] as const;
function resume(s: ConnectStatus): Stage {
  const w = s.workspace!;
  if (w.phase === "awaiting_approval" || w.step === "activate") return "activate";
  if (w.step === "output") return "output";
  if (w.step === "review") return "first";
  if (w.phase === "active" && w.step === "overview") return "done";
  if (w.step !== "order") return "files";
  return w.sources.some((v) => v.roles.includes("order")) ? "checked" : "welcome";
}
function message(e: unknown) {
  return e instanceof Error ? e.message : "PackProof couldn’t complete this step. Try again.";
}
function stamp(value?: string) {
  if (!value) return "";
  const t = new Date(value);
  return Number.isNaN(t.valueOf())
    ? value
    : t.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function Setup({
  status,
  bridge,
  onStatus,
  onComplete,
  onSample,
  onOpenDraftProof,
  onBusyChange,
  onLegacy,
}: Props) {
  const ws = status.workspace!;
  const [stage, setStage] = useState<Stage>(() => resume(status));
  const [role, setRole] = useState<SourceRole>(() => (ws.step in roles ? (ws.step as SourceRole) : "order"));
  const [provider, setProvider] = useState(""),
    [partnerSystem, setPartnerSystem] = useState("");
  const [overlay, setOverlay] = useState<"help" | "export" | "sources" | "issues" | "facts" | null>(null);
  const [event, setEvent] = useState<Example["events"][number] | null>(null);
  const [selectedIndex, selectIndex] = useState(0),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [preview, setPreview] = useState<DraftPreview | null>(null),
    [previewError, setPreviewError] = useState("");
  const [attempt, retry] = useState(0);
  const [suggestion, setSuggestion] = useState<{ folder: string; kind: "prepared" | "selected" } | null>(
    null,
  );
  const pending = useRef(false),
    alive = useRef(true),
    heading = useRef<HTMLHeadingElement>(null);
  const sources = ws.sources.filter((s) => s.roles.length),
    current = sources.filter((s) => s.roles.includes(role)),
    ready = sources.filter(eligible);
  const selected = preview?.examples[selectedIndex];
  const output = ws.outputFolder || status.proofOutput?.folder;
  const outputReady =
    ws.outputState === "ready" ||
    (!ws.outputState && ["ready", "current", "pending"].includes(status.proofOutput?.state || ""));
  const tempOutput = !!output && ws.outputState === "unavailable";
  const enrolling =
    !status.installationId &&
    status.enrollment?.state === "pending" &&
    Date.parse(status.enrollment.expiresAt) > Date.now();
  const awaiting =
    ws.phase === "awaiting_approval" && (!ws.expiresAt || Date.parse(ws.expiresAt) > Date.now());
  const permissionDenied = ["revoked", "permission_required"].includes(status.state);
  const signature = JSON.stringify(
    sources.map((s) => [s.id, s.generation, s.state, s.recognition.state, s.recognition.profileVersion]),
  );
  const showPreview = stage === "checked" || stage === "first";
  useEffect(() => {
    alive.current = true;
    const help = () => setOverlay("help");
    window.addEventListener("packproof-setup-help", help);
    return () => {
      alive.current = false;
      window.removeEventListener("packproof-setup-help", help);
    };
  }, []);
  useEffect(() => {
    heading.current?.focus();
  }, [stage]);
  useEffect(() => {
    if (ws.phase === "active" && ws.step === "overview") setStage("done");
    if (ws.phase === "awaiting_approval") setStage("activate");
  }, [ws.phase, ws.step]);
  useEffect(() => {
    if (!showPreview) return;
    let live = true;
    selectIndex(0);
    setPreview(null);
    setPreviewError("");
    void bridge
      .workspaceDraftPreview()
      .then((v) => {
        if (live) setPreview(v);
      })
      .catch((e) => {
        if (live) setPreviewError(message(e));
      });
    return () => {
      live = false;
    };
  }, [showPreview, signature, bridge, attempt]);
  async function run<T>(label: string, fn: () => Promise<T>, after?: (r: T) => void) {
    if (pending.current) return;
    pending.current = true;
    onBusyChange?.(true);
    setBusy(label);
    setError("");
    try {
      const result = await fn();
      if (alive.current) after?.(result);
    } catch (e) {
      if (alive.current) setError(message(e));
    } finally {
      pending.current = false;
      onBusyChange?.(false);
      if (alive.current) setBusy("");
    }
  }
  function accept(next: ConnectStatus) {
    onStatus(next);
    if (next.error) throw Error(next.error.message);
  }
  function move(saved: WorkspaceStep, screen: Stage) {
    void run(
      "Saving your place",
      () => bridge.saveWorkspaceStep(saved),
      (s) => {
        accept(s);
        setStage(screen);
      },
    );
  }
  function choose(suggested = false) {
    void run(
      "Checking your folder",
      () =>
        suggested && suggestion && bridge.useWorkspaceFolderSuggestion
          ? bridge.useWorkspaceFolderSuggestion(role, suggestion.folder)
          : bridge.chooseWorkspaceFolder(role),
      (s) => {
        accept(s);
        if (s.workspace?.sources.some((x) => x.roles.includes(role))) {
          retry((i) => i + 1);
          setStage("checked");
        }
      },
    );
  }
  function discover() {
    void run(
      "Looking for a records folder",
      async () => bridge.getWorkspaceFolderSuggestion?.(role) ?? null,
      (s) => {
        setSuggestion(s);
        setStage("discover");
      },
    );
  }
  function sourceStep(r: SourceRole) {
    void run(
      "Saving your place",
      () => bridge.saveWorkspaceStep(r),
      (s) => {
        accept(s);
        setRole(r);
        setProvider("");
        setOverlay(null);
        setStage("files");
      },
    );
  }
  const act = (label: string, fn: () => void, secondary = false, disabled = false) => (
    <button
      type="button"
      className={secondary ? "setup-secondary" : "setup-primary"}
      disabled={!!busy || disabled}
      onClick={fn}
    >
      {label}
    </button>
  );
  const back = (s: Stage, label = "Back") => (
    <button
      type="button"
      className="setup-link"
      disabled={!!busy}
      onClick={() => {
        setError("");
        setStage(s);
      }}
    >
      ‹ &nbsp;{label}
    </button>
  );
  const goPreview = () => move("review", "first");
  const sampleLink = (
    <button className="setup-link" type="button" onClick={onSample}>
      Try a sample order
    </button>
  );
  const draftStatus = previewError ? (
    <p role="alert">
      {previewError}{" "}
      <button className="setup-link" onClick={() => retry((i) => i + 1)}>
        Check again
      </button>
    </p>
  ) : !preview ? (
    <p role="status">Looking for matching order records…</p>
  ) : null;
  const selectExample = preview && preview.examples.length > 1 && (
    <label className="setup-select">
      Choose order
      <select value={selectedIndex} onChange={(e) => selectIndex(Number(e.target.value))}>
        {preview.examples.map((ex, i) => (
          <option key={i} value={i}>
            {ex.orderReference} · {ex.source}
          </option>
        ))}
      </select>
    </label>
  );
  const roleName = role === "order" ? "order" : roles[role].title.toLowerCase().replace(/ records$/, "");
  let title: ReactNode, intro: string | undefined, left: ReactNode, right: ReactNode, eyebrow: ReactNode;

  if (stage === "welcome") {
    title = (
      <>
        Your orders.
        <br />
        One clear story.
      </>
    );
    eyebrow = <span className="setup-accent" />;
    intro =
      "Bring the order, packing list, and shipment together. Start with the records your team already uses. We’ll look for a matched order before you turn on updates.";
    left = (
      <>
        <div className="setup-actions">
          {act("Connect my records", () => setStage("start"))}
          {act("Try a sample order", onSample, true)}
        </div>
        <p className="setup-hint">The sample opens immediately. You can start setup whenever you’re ready.</p>
      </>
    );
    right = <WelcomeExample />;
  } else if (stage === "start") {
    title = (
      <>
        Where do you look
        <br />
        up a customer order?
      </>
    );
    intro = "Choose the place you’d open to check what someone bought.";
    eyebrow = <Progress n={1} label="Choose a starting point" />;
    left = (
      <>
        <div className="setup-choice-list">
          <Row
            icon="computer"
            title="In our order software"
            detail="An online store, warehouse program, or accounting system."
            onClick={() => setStage("software")}
          />
          <Row
            icon="folder"
            title="In a spreadsheet or folder"
            detail="A saved order list or an export from another program."
            onClick={() => setStage("files")}
          />
          <Row
            icon="search"
            title="Help me find my records"
            detail="Look for an order export on this computer."
            onClick={discover}
            disabled={!!busy}
          />
        </div>
        {back("welcome")}
      </>
    );
    right = (
      <Context
        label="What happens next"
        title={
          <>
            Start with one
            <br />
            familiar order.
          </>
        }
        intro="Choose one source now. You can add more from your workspace later."
        footer="Your original records stay in your system."
      >
        <Row
          icon="folder"
          title="Find your order records"
          detail="Choose a system or a folder with order lists."
        />
        <Row icon="search" title="See what PackProof can read" detail="Check the order number and items." />
        <Row
          icon="sync"
          title="Turn on automatic updates"
          detail="New records will be added as they arrive."
        />
      </Context>
    );
  } else if (stage === "software") {
    eyebrow = <Progress n={2} label="Find your records" />;
    title = (
      <>
        Which software does
        <br />
        your team use?
      </>
    );
    intro = "Choose the software you open when a customer places an order.";
    left = (
      <>
        <div className="setup-grid">
          {providers.map(([p, d, icon]) => (
            <Row
              key={p}
              icon={icon}
              title={p}
              detail={d}
              onClick={() => {
                setProvider(p);
                setStage("softwareChoice");
              }}
            />
          ))}
        </div>
        <button
          className="setup-link"
          onClick={() => {
            setProvider("");
            setStage("files");
          }}
        >
          My software is missing. Use an order export instead.
        </button>
        <details className="setup-partner">
          <summary>Use an existing PackProof Partner API integration</summary>
          <p>
            For a system your team has already integrated. Use the system identifier supplied by your
            integration owner when it has a dedicated feed.
          </p>
          <label>
            System identifier (optional)
            <input value={partnerSystem} onChange={(e) => setPartnerSystem(e.target.value)} maxLength={100} />
          </label>
          {act(
            "Connect PackProof Partner API",
            () =>
              void run(
                "Adding your order connection",
                () => bridge.addWorkspaceDirectSource(partnerSystem.trim() || undefined),
                (s) => {
                  accept(s);
                  setStage("checked");
                },
              ),
            true,
          )}
        </details>
        {back("start")}
      </>
    );
    right = (
      <Context
        label="Why this matters"
        title={
          <>
            Start with the tool
            <br />
            you already use.
          </>
        }
        intro="Look for the name on the screen where you open a customer order or check what they bought."
        footer="You choose which records PackProof can read."
      >
        <Row icon="computer" title="Your order system" detail="Order numbers, items, and updates" />
      </Context>
    );
  } else if (stage === "softwareChoice") {
    eyebrow = <Progress n={2} label="Connect your software" />;
    title = `Connect your ${provider} orders.`;
    intro = `Choose the folder where ${provider} saves order exports. PackProof checks the files before you approve ongoing access.`;
    left = (
      <>
        <div className="setup-choice-list">
          <Row
            icon="folder"
            title="Choose my export folder"
            detail="Use the order files your team already saves."
            onClick={() => choose()}
            disabled={!!busy}
          />
          <Row icon="help" title="Help me export an order list" onClick={() => setOverlay("export")} />
        </div>
        {back("software", "Use a different source")}
      </>
    );
    right = (
      <Context
        label="Order source"
        title="Read one order first."
        intro="Check that the order number and items match your system. You can review exactly what will be collected."
        footer="Your original records stay in your system."
      >
        <Row icon="computer" title={provider} detail="Order export" />
        <Row icon="order" title="Check a matching order" detail="Preview the records on this computer." />
      </Context>
    );
  } else if (stage === "discover") {
    eyebrow = <Progress n={2} label="Folder discovery" />;
    title = suggestion ? "Is this your order folder?" : "Where do you save your exports?";
    intro = suggestion
      ? "Check the location before PackProof reads its records."
      : "There’s no suggested folder on this computer. Pick the location where you save exported order lists.";
    left = (
      <>
        {suggestion && (
          <Row icon="folder" title={shortFolder(suggestion.folder)} detail={suggestion.folder} />
        )}
        <div className="setup-actions">
          {suggestion && act("Check this folder", () => choose(true))}
          {act(suggestion ? "Choose another folder" : "Choose a folder", () => choose(), !!suggestion)}
        </div>
        {back("files")}
      </>
    );
    right = (
      <Context
        label="Folder check"
        title="Choose the source you recognize."
        intro="Use the folder containing the actual order list, such as an export from your order system."
        footer="You can add other record folders later."
      >
        <Row icon="file" title="Order export" detail="Look for order numbers, items, and quantities." />
      </Context>
    );
  } else if (stage === "files") {
    eyebrow = <Progress n={2} label="Find your records" />;
    title =
      role === "order" ? (
        <>
          Where are your
          <br />
          order files?
        </>
      ) : (
        `Where are your ${roles[role].title.toLowerCase()}?`
      );
    intro =
      role === "order"
        ? "Look for the folder where your team saves its customer order lists."
        : "Choose the location where your team saves these records.";
    left = (
      <>
        <div className="setup-choice-list">
          <Row
            icon="search"
            title={`Find my ${roleName} folder`}
            detail="Check the suggested location before choosing."
            onClick={discover}
            disabled={!!busy}
          />
          <Row
            icon="folder"
            title="Choose a folder myself"
            detail="Browse folders on this computer."
            onClick={() => choose()}
            disabled={!!busy}
          />
          {sources
            .filter((s) => s.transport !== "api" && !s.roles.includes(role))
            .map((s) => (
              <Row
                key={s.id}
                icon="connection"
                title={`Use ${sourceName(s)}`}
                detail="Already selected on this computer."
                disabled={!!busy}
                onClick={() =>
                  void run(
                    "Checking this location",
                    () => bridge.reuseWorkspaceFolder(s.id, role),
                    (next) => {
                      accept(next);
                      setStage("checked");
                    },
                  )
                }
              />
            ))}
        </div>
        <button className="setup-link" onClick={() => setOverlay("export")}>
          How do I export a report?
        </button>
        {role === "order" ? (
          back("start")
        ) : (
          <button className="setup-link" onClick={goPreview}>
            Skip for now
          </button>
        )}
      </>
    );
    right = (
      <Context
        label="Why this matters"
        title={
          <>
            What an order
            <br />
            file looks like.
          </>
        }
        intro="Look for records that identify the order or shipment. PackProof uses those references to match records from each source."
        footer="An order number helps PackProof match records."
      >
        <div className="setup-sample-table">
          <Row icon="file" title="orders_november.csv" detail="Example order export" />
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Customer</th>
                <th>Items</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>10482</td>
                <td>North Ridge</td>
                <td>3</td>
              </tr>
              <tr>
                <td>10483</td>
                <td>Cedar Tools</td>
                <td>5</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Context>
    );
  } else if (stage === "checked") {
    eyebrow = <Progress n={3} label="Check your source" />;
    const empty =
      role === "order" &&
      current.length > 0 &&
      current.every((s) => s.transport !== "api" && s.recognition.state === "empty") &&
      !selected;
    title = empty
      ? "No order lists in this folder yet."
      : selected
        ? "Your order files are ready to review."
        : current.some((s) => s.transport === "api")
          ? "Your order connection is ready to review."
          : "Check your records folder.";
    intro = empty
      ? "The folder opened successfully. Save an order export here, choose a different folder, or connect this location to watch for future records."
      : selected
        ? "Open an order and check that the items look familiar."
        : "Review what PackProof found before turning on automatic updates.";
    left = (
      <>
        <div className="setup-card">
          <span className="setup-tag">Source check</span>
          {current.map((s) => (
            <div key={s.id}>
              <Row
                icon={s.transport === "api" ? "connection" : "folder"}
                title={sourceName(s)}
                detail={s.recognition.message}
              />
              <Clarify
                source={s}
                bridge={bridge}
                busy={!!busy}
                apply={(f) => void run("Checking your source", f, accept)}
              />
              {s.transport !== "api" && (
                <button
                  className="setup-link"
                  disabled={!!busy}
                  onClick={() =>
                    void run(
                      "Checking the folder",
                      () => bridge.inspectWorkspaceSource(s.id),
                      (next) => {
                        accept(next);
                        retry((v) => v + 1);
                      },
                    )
                  }
                >
                  Check folder again
                </button>
              )}
              <button
                className="setup-link"
                disabled={!!busy}
                onClick={() =>
                  void run(
                    "Removing this source from setup",
                    () => bridge.removeWorkspaceRole(s.id, role),
                    (next) => {
                      accept(next);
                      if (!next.workspace?.sources.some((x) => x.roles.includes(role))) setStage("files");
                    },
                  )
                }
              >
                Remove from this step
              </button>
            </div>
          ))}
          {draftStatus}
          {preview && (
            <p>
              {preview.scannedFiles} {preview.scannedFiles === 1 ? "file checked" : "files checked"}
              {preview.limited ? " · Showing a sample" : ""}
            </p>
          )}
          {preview && !!(preview.unreadFiles || preview.unresolved) && (
            <button className="setup-link" onClick={() => setOverlay("issues")}>
              View files or records needing review
            </button>
          )}
        </div>
        {empty && (
          <div className="setup-choice-list">
            <Row
              icon="file"
              title="Export an order list"
              detail="Save a file from the program where you open orders."
              onClick={() => setOverlay("export")}
            />
            <Row
              icon="sample"
              title="Try a sample order first"
              detail="See how the records fit together."
              onClick={onSample}
            />
          </div>
        )}
        {selectExample}
        <div className="setup-actions">
          {selected
            ? act(`Open order ${selected.orderReference}`, goPreview)
            : ready.length > 0
              ? act("Continue setup", goPreview)
              : null}
          {act("Choose another folder", () => choose(), true)}
        </div>
        <button className="setup-link" onClick={() => setOverlay("sources")}>
          Add another source
        </button>
      </>
    );
    right = (
      <Context
        label={selected ? "Matched order" : "Source preview"}
        title={selected ? "Does this order look familiar?" : "Waiting for the first order."}
        intro={
          selected
            ? "PackProof read this order locally. Open it to check the linked records."
            : current.some((s) => s.transport === "api")
              ? "Once your connection is approved, your integration can submit order records to this workspace."
              : "Save an order export in your chosen folder and check again. An empty folder can also be connected for future records."
        }
        footer="Updates start only when you turn them on."
      >
        {selected ? (
          <Row
            icon="order"
            title={selected.orderReference}
            detail={`${selected.lines.length} item lines in this preview · ${selected.source}`}
          />
        ) : (
          sampleLink
        )}
      </Context>
    );
  } else if (stage === "first") {
    eyebrow = <Progress n={4} label="Review your first order" />;
    title = selected ? "Review your first order" : "Review your sources";
    intro = selected
      ? "Check the items below. Select a stage to inspect its record."
      : "You can add more sources now or from your workspace later.";
    left = (
      <>
        {draftStatus}
        {selectExample}
        {selected ? (
          <>
            <section className="setup-card">
              <span className="setup-tag">Order found</span>
              <h3>{selected.orderReference}</h3>
              <p>
                {selected.lines
                  .map((l) => l.sku || l.lineId)
                  .filter(Boolean)
                  .join(" · ") || selected.source}
              </p>
            </section>
            <section className="setup-card">
              <h3>Order history</h3>
              {selected.events.map((ev, i) => (
                <Row
                  key={i}
                  icon={kindNames[ev.kind]?.[0] || "records"}
                  title={kindNames[ev.kind]?.[1] || ev.kind}
                  detail={ev.fileName}
                  onClick={() => setEvent(ev)}
                />
              ))}
              {!selected.events.length && <p>Waiting for linked records.</p>}
            </section>
          </>
        ) : (
          <div className="setup-card">
            {sources.map((s) => (
              <Row
                key={s.id}
                icon={roles[s.roles[0]].icon}
                title={sourceName(s)}
                detail={s.recognition.message}
              />
            ))}
            {!sources.length && <p>Choose a source to connect your records.</p>}
          </div>
        )}
        {preview && preview.unresolved > 0 && (
          <p className="setup-hint">
            {preview.unresolved} {preview.unresolved === 1 ? "record needs" : "records need"} an order
            reference.
          </p>
        )}
        <div className="setup-actions">
          {act("Turn on automatic updates", () => move("output", "output"), false, !ready.length)}
          {act("Back to source check", () => setStage("checked"), true)}
        </div>
        <button className="setup-link" onClick={() => setOverlay("sources")}>
          Add another source
        </button>
      </>
    );
    right = (
      <Context
        label="Matched records"
        title={
          <>
            How the records
            <br />
            fit together
          </>
        }
        intro="PackProof links records that share an order, shipment, or package reference. Each event keeps its source."
        footer="Your order preview uses your selected sources."
      >
        {selected ? (
          <>
            <h3>Supporting records</h3>
            {selected.events.slice(0, 3).map((ev, i) => (
              <Row
                key={i}
                icon={kindNames[ev.kind]?.[0] || "records"}
                title={ev.fileName}
                detail={ev.source}
                onClick={() => setEvent(ev)}
              />
            ))}
            <button
              className="setup-link"
              onClick={() => (onOpenDraftProof ? onOpenDraftProof(selected) : setOverlay("facts"))}
            >
              Open the full proof ›
            </button>
          </>
        ) : (
          <>
            <p>
              There’s no matched order in the local preview yet. New eligible records will appear after you
              connect your sources.
            </p>
            {sampleLink}
          </>
        )}
      </Context>
    );
  } else if (stage === "output" || stage === "activate") {
    eyebrow = <Progress n={4} label="Turn on updates" />;
    const approval = stage === "activate";
    title = approval ? (
      <>
        Connect your
        <br />
        records.
      </>
    ) : (
      "Where should we save your proofs?"
    );
    intro = approval
      ? "Review the request in your browser. Connect will keep your place."
      : "Choose a separate folder for local copies of your order proofs. You can also open them in your workspace.";
    left = (
      <>
        <div className="setup-card">
          <span className="setup-tag">{approval ? "Source access" : "Proof folder"}</span>
          {approval &&
            ready.map((s) => (
              <Row
                key={s.id}
                icon={roles[s.roles[0]].icon}
                title={sourceName(s)}
                detail={s.roles.map((r) => roles[r].title).join(" · ")}
              />
            ))}
          <Row
            icon="folder"
            title={output ? shortFolder(output) : "Choose a proof folder"}
            detail={output || "A location where PackProof can save completed proofs."}
          />
          {output && (
            <p>
              {outputReady
                ? "The background service can save proofs here."
                : tempOutput
                  ? "This folder is temporarily unavailable. You can start with local copies pending."
                  : "The service needs write access. Choose a different folder or check its permissions."}
            </p>
          )}
          {!approval &&
            act(
              output ? "Change folder" : "Choose proof folder",
              () => void run("Checking write access", () => bridge.chooseWorkspaceOutput(), accept),
              !!output,
            )}
        </div>
        {approval && (
          <>
            <p className="setup-hint">
              PackProof will retain approved originals from these sources. Folder connections read existing
              and future eligible files in the selected folders.
            </p>
            {sources.length > ready.length && (
              <p>
                {sources.length - ready.length} sources need attention and will be left out of this request.
              </p>
            )}
            {enrolling && status.enrollment?.comparisonCode && (
              <p>
                Match this code in your browser &nbsp;<strong>{status.enrollment.comparisonCode}</strong>
              </p>
            )}
            {status.authorizationNotice && <p role="status">{status.authorizationNotice}</p>}
          </>
        )}
        <div className="setup-actions">
          {approval
            ? awaiting || enrolling
              ? act(
                  "Open browser review",
                  () => void run("Opening the approval request", () => bridge.openWorkspaceApproval()),
                )
              : act(
                  tempOutput ? "Start with local copies pending" : "Review in browser",
                  () =>
                    void run(
                      "Requesting approval",
                      () => bridge.activateWorkspace(tempOutput ? true : undefined),
                      accept,
                    ),
                  false,
                  !ready.length || !output || (!tempOutput && !outputReady) || permissionDenied,
                )
            : act(
                "Continue",
                () => move("activate", "activate"),
                false,
                !output || (!outputReady && !tempOutput),
              )}
          {!awaiting &&
            !enrolling &&
            act("Back", () => (approval ? move("output", "output") : move("review", "first")), true)}
        </div>
      </>
    );
    right = (
      <Context
        label={approval ? "We keep your place" : "Your workspace"}
        title={
          approval ? (
            <>
              You’ll come back
              <br />
              to this setup.
            </>
          ) : (
            "One place for every order."
          )
        }
        intro={
          approval
            ? "If your browser asks you to sign in, use your work account. It will open the request for this connection."
            : "The background service writes updated proof copies here as new records arrive."
        }
        footer={
          approval
            ? "You can close the browser once approval is complete."
            : "Your source folders and your proof folder stay separate."
        }
      >
        <Row
          icon={approval ? "browser" : "folder"}
          title={approval ? "Review read access" : "Choose a destination"}
          detail={
            approval
              ? "Confirm your sources and their access."
              : "Choose a writable location for your proofs."
          }
        />
        <Row icon="computer" title="Return to PackProof" detail="Open the workspace to see your orders." />
      </Context>
    );
  } else {
    eyebrow = <span className="setup-accent" />;
    title = "Automatic updates are on.";
    intro = "You can close this window. PackProof keeps checking your connected sources in the background.";
    left = (
      <>
        <div className="setup-card">
          <h3>What happens from here</h3>
          <Row
            icon="sync"
            title="Check for new orders"
            detail="As new records arrive from connected sources"
          />
          <Row
            icon="layers"
            title="Connect matching records"
            detail="Using shared order numbers and shipment references"
          />
          <Row
            icon="attention"
            title="Show what needs attention"
            detail="When a record or connection needs review"
          />
        </div>
        <div className="setup-actions">{act("Open my workspace", onComplete)}</div>
      </>
    );
    right = (
      <Context
        label="Your workspace"
        title={
          <>
            Come back when
            <br />
            an order needs you.
          </>
        }
        intro="Open any order to see its history. Needs attention brings missing records and interrupted connections into one list."
      >
        <Row
          icon="connection"
          title="Connected sources"
          detail={String(sources.filter((s) => s.state === "active").length)}
        />
        <Row
          icon="clock"
          title="Last source check"
          detail={stamp(status.health.lastScanAt) || "Waiting for the first check"}
        />
      </Context>
    );
  }
  return (
    <main
      className={"setup-experience step-" + stage}
      data-setup-screen={stage}
      aria-label="Connection setup"
    >
      <div className="setup-left">
        {eyebrow}
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {intro && <p className="setup-lead">{intro}</p>}
        {left}
        {ws.phase === "active" && ws.step !== "overview" && (
          <button
            className="setup-link"
            disabled={!!busy}
            onClick={() =>
              void run(
                "Opening your workspace",
                () => bridge.saveWorkspaceStep("overview"),
                (s) => {
                  accept(s);
                  onComplete();
                },
              )
            }
          >
            Return to workspace
          </button>
        )}
        {onLegacy && (status.config || !!status.sourceSubscriptions?.length || status.recoveryAvailable) && (
          <details className="setup-partner">
            <summary>Existing connections</summary>
            <button className="setup-link" onClick={onLegacy}>
              Manage earlier connections
            </button>
          </details>
        )}
        {busy && <p role="status">{busy}…</p>}
        {error && (
          <p className="setup-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {right}
      {overlay && (
        <SetupDialog
          title={
            {
              help: "Find the right starting point",
              export: "Save your first order list",
              sources: "Which records would you like to add?",
              issues: "Records needing review",
              facts: "Order preview",
            }[overlay]
          }
          onClose={() => setOverlay(null)}
        >
          {overlay === "help" && (
            <>
              <p>
                Think of the last time someone asked what was on an order. The place you looked it up is
                usually the source to connect.
              </p>
              <Row
                icon="computer"
                title="You opened a program or online store"
                detail="Choose that software under “In our order software.”"
              />
              <Row
                icon="folder"
                title="You opened a file"
                detail="Use the folder where your team saves its order lists."
              />
              {sampleLink}
            </>
          )}
          {overlay === "export" && (
            <>
              <Row
                icon="computer"
                title="Open your order list"
                detail="Look for Orders, Sales orders, or Order history in your software."
              />
              <Row
                icon="file"
                title="Export the list"
                detail="Choose Export or Download. Include order numbers and items."
              />
              <Row
                icon="folder"
                title="Save it to a folder you can find"
                detail="For example, Documents / Order exports."
              />
              {act("Choose the folder", () => {
                setOverlay(null);
                choose();
              })}
            </>
          )}
          {overlay === "sources" &&
            (Object.keys(roles) as SourceRole[]).map((r) => (
              <Row
                key={r}
                icon={roles[r].icon}
                title={roles[r].title}
                disabled={!!busy}
                onClick={() => sourceStep(r)}
              />
            ))}
          {overlay === "issues" && preview && (
            <>
              <p>{preview.unreadFiles} files could not provide order details.</p>
              <p>{preview.unresolved} records could not be matched to an order.</p>
              {act("Check again", () => {
                setOverlay(null);
                retry((v) => v + 1);
              })}
            </>
          )}
          {overlay === "facts" && selected && (
            <>
              <h3>{selected.orderReference}</h3>
              <p>{selected.source} · Local preview</p>
              {selected.lines.map((l, i) => (
                <Row key={i} icon="list" title={l.sku || l.lineId} detail={[l.quantity, l.unit].join(" ")} />
              ))}
              {selected.events.map((e, i) => (
                <Row key={i} icon="records" title={e.fileName} detail={e.source} />
              ))}
            </>
          )}
        </SetupDialog>
      )}
      {event && (
        <SetupDialog title={kindNames[event.kind]?.[1] || "Source record"} onClose={() => setEvent(null)}>
          <Row icon="file" title={event.fileName} detail={event.source} />
          {event.occurredAt && <p>Recorded {stamp(event.occurredAt)}</p>}
          {event.shared && <p>This record is shared by more than one order.</p>}
          <p>Local source preview</p>
        </SetupDialog>
      )}
    </main>
  );
}

function Clarify({
  source,
  bridge,
  apply,
  busy,
}: {
  source: WorkspaceSource;
  bridge: WorkspaceBridge;
  apply: (f: () => Promise<ConnectStatus>) => void;
  busy: boolean;
}) {
  const r = source.recognition;
  if (r.state !== "ambiguous") return null;
  const choice = r.relatedChoices?.[0];
  if (choice)
    return (
      <fieldset className="setup-clarify">
        <legend>{r.question || "Which source supplies this reference?"}</legend>
        {choice.options.map((o) => (
          <button
            key={o.id}
            className="setup-secondary"
            disabled={busy}
            onClick={() =>
              apply(() =>
                bridge.chooseWorkspaceRelatedSource(source.id, source.generation, choice.role, o.id),
              )
            }
          >
            {o.displayName}
          </button>
        ))}
      </fieldset>
    );
  if (!r.question || !r.profileVersion) return null;
  return (
    <div className="setup-clarify">
      <p>{r.question}</p>
      {r.suggestedOrderColumn && r.sample?.[r.suggestedOrderColumn] && (
        <p>Example · {r.sample[r.suggestedOrderColumn]}</p>
      )}
      <button
        className="setup-secondary"
        disabled={busy}
        onClick={() =>
          apply(() => bridge.confirmWorkspaceOrderMap(source.id, source.generation, r.profileVersion!))
        }
      >
        Confirm this reference
      </button>
    </div>
  );
}
