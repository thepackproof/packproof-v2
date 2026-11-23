import { useState } from "react";
import { sourceRoles, type WorkspaceSource, type WorkspaceStep } from "../workspace-types";
import type { RunAction, WorkspaceProps } from "./WorkspaceModel";
import { canReadWorkspace, sourceIcon, sourceIssue, sourceState, sourceTitle } from "./WorkspaceModel";
import { Icon } from "./Icon";
import { RecoveryPanel } from "./RecoveryPanel";
import { roles, SetupDialog } from "./SetupParts";

export function CollectionBanner({ status, open }: { status: WorkspaceProps["status"]; open?: () => void }) {
  const ws = status.workspace!,
    sources = ws.sources.filter((s) => s.roles.length);
  const offline =
    ws.canReadOrders === false ||
    ["unreachable", "unauthenticated", "forbidden"].includes(status.transport?.state || "");
  const active = sources.filter((s) => s.state === "active").length,
    problems = sources.filter((s) => sourceIssue(s)).length;
  const paused = sources.length > 0 && sources.every((s) => s.state === "paused");
  const title = offline
    ? "Workspace connection interrupted"
    : active
      ? "Collection is running"
      : paused
        ? "Collection is paused"
        : ws.phase === "awaiting_approval"
          ? "Waiting for approval"
          : "Checking your connections";
  const detail = offline
    ? "Reconnect to see the latest orders."
    : problems
      ? problems + " " + (problems === 1 ? "source needs" : "sources need") + " a closer look."
      : active
        ? active + " " + (active === 1 ? "source is" : "sources are") + " collecting records."
        : paused
          ? "Resume a source when you're ready to collect again."
          : "Check your sources for their latest status.";
  return (
    <div className={"xw-banner " + (offline ? "xw-banner-warn" : "")}>
      {open && (
        <span className="xw-smalltile">
          <Icon name={offline ? "attention" : "sync"} size={28} />
        </span>
      )}
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
      {open && (
        <button className="xw-link" onClick={open}>
          View sources <span aria-hidden="true">→</span>
        </button>
      )}
    </div>
  );
}
type Props = WorkspaceProps & {
  run: RunAction;
  busy: boolean;
  sourceId: string | null;
  onSource: (id: string | null) => void;
};
export function Connections({
  status,
  bridge,
  onSection,
  onEditStep,
  onLegacy,
  run,
  busy,
  sourceId,
  onSource,
}: Props) {
  const ws = status.workspace!,
    readable = canReadWorkspace(status),
    srcs = readable ? ws.sources.filter((s) => s.roles.length) : [];
  const [adding, setAdding] = useState(false);
  const source = srcs.find((s) => s.id === sourceId);
  const folder = readable ? status.proofOutput?.folder || ws.outputFolder : undefined;
  const edit = (step: WorkspaceStep) => {
    setAdding(false);
    if (onEditStep) void onEditStep(step);
  };
  // A cached source list is not facility permission. An opened SourceView must
  // disappear immediately when the service, transport or hosted scope is lost.
  if (!readable) return (
    <>
      <header className="xw-heading">
        <div>
          <h1>Connection needs attention</h1>
          <p>Restore your approved facility connection to inspect its sources.</p>
        </div>
      </header>
      <div className="xw-card xw-empty" role="status">
        <Icon name="attention" size={32} />
        <h2>{status.health.serviceOnline ? "Facility access isn't confirmed" : "Background collector unavailable"}</h2>
        <p>Saved source names, local paths and collection settings are hidden until current access is verified.</p>
        <div className="xw-btns">
          <button className="xw-secondary" disabled={busy}
            onClick={() => void run(() => bridge.getWorkspaceStatus())}>Check connection again</button>
          <button className="xw-secondary" disabled={busy}
            onClick={() => void run(() => bridge.openPortal())}>Review access online</button>
        </div>
      </div>
    </>
  );
  if (source)
    return (
      <SourceView
        source={source}
        bridge={bridge}
        run={run}
        busy={busy}
        onBack={() => onSource(null)}
        edit={edit}
      />
    );
  return (
    <>
      <header className="xw-heading">
        <div>
          <h1>Your connections</h1>
          <p>Everything PackProof uses to keep your orders up to date.</p>
        </div>
        <button className="xw-primary" onClick={() => setAdding(true)}>
          Connect another source
        </button>
      </header>
      <CollectionBanner status={status} />
      <RecoveryPanel status={status} sources={srcs} busy={busy} run={run} bridge={bridge}
        onSource={onSource} onOutputSetup={() => edit("output")}/>
      <div className="xw-connection-list">
        {srcs.map((s) => (
          <article key={s.id} className="xw-card xw-sourcecard">
            <span className={"xw-tile xw-tile-" + sourceIcon(s)}>
              <Icon name={sourceIcon(s)} size={42} />
            </span>
            <div>
              <h2>{sourceTitle(s)}</h2>
              <p>
                {s.roles.map((r) => roles[r].title).join(" · ")} ·{" "}
                {sourceIssue(s) || (s.state === "paused" ? "Collection paused" : s.recognition.message)}
              </p>
              <button className="xw-link" onClick={() => onSource(s.id)}>
                {sourceIssue(s) ? "Fix connection" : "View connection"} <span aria-hidden="true">→</span>
              </button>
            </div>
            <span
              className={
                "xw-badge " + (sourceIssue(s) ? "xw-warn" : s.state === "active" ? "xw-green" : "xw-blue")
              }
            >
              {sourceState(s)}
            </span>
          </article>
        ))}
        {!srcs.length && (
          <p className="xw-card xw-empty">Choose the first records source for this workspace.</p>
        )}
      </div>
      <button className="xw-link" onClick={() => onSection("attention")}>
        Open all items needing attention <span aria-hidden="true">→</span>
      </button>
      <details className="xw-settings">
        <summary>Workspace settings</summary>
        <h3>Proof folder</h3>
        <p>{folder || "Choose a destination for local proofs."}</p>
        {status.proofOutput && status.proofOutput.pending > 0 && (
          <p>{status.proofOutput.pending} local copies pending.</p>
        )}
        <div className="xw-btns">
          {folder && (
            <button
              className="xw-secondary"
              disabled={busy}
              onClick={() => void run(() => bridge.openWorkspaceOutput())}
            >
              Open proof folder
            </button>
          )}
          <button className="xw-secondary" disabled={busy} onClick={() => edit("output")}>
            Change proof folder
          </button>
        </div>
        <h3>Account and support</h3>
        <div className="xw-btns">
          <button
            className="xw-secondary"
            disabled={busy}
            onClick={() => void run(() => bridge.openPortal())}
          >
            Manage online connections
          </button>
          <button
            className="xw-secondary"
            disabled={busy}
            onClick={() => void run(() => bridge.exportDiagnostics())}
          >
            Export diagnostics
          </button>
          {!!onLegacy &&
            (status.recoveryAvailable || status.config || !!status.sourceSubscriptions?.length) && (
              <button className="xw-secondary" onClick={onLegacy}>
                Manage earlier connections
              </button>
            )}
        </div>
      </details>
      {adding && (
        <SetupDialog title="Connect another source" onClose={() => setAdding(false)}>
          <p>What kind of records does this source provide?</p>
          <div className="xw-roles">
            {sourceRoles.map((role) => (
              <button key={role} className="xw-secondary" onClick={() => edit(role)}>
                <Icon name={roles[role].icon} size={26} />
                {roles[role].title}
              </button>
            ))}
          </div>
        </SetupDialog>
      )}
    </>
  );
}

function SourceView({
  source: s,
  bridge,
  run,
  busy,
  onBack,
  edit,
}: {
  source: WorkspaceSource;
  bridge: WorkspaceProps["bridge"];
  run: RunAction;
  busy: boolean;
  onBack: () => void;
  edit: (step: WorkspaceStep) => void;
}) {
  const [help, setHelp] = useState(false),
    [verified, setVerified] = useState(false);
  const issue = sourceIssue(s),
    api = s.transport === "api",
    folderIssue =
      s.recognition.state === "unavailable" ||
      /UNREADABLE|ACCESS_DENIED|READ_FAILED|FOLDER_UNAVAILABLE/.test(s.issue || "");
  const primary = s.roles[0] || "order",
    title = sourceTitle(s);
  const inspect = () =>
    run(async () => {
      const next = await bridge.inspectWorkspaceSource(s.id),
        checked = next.workspace?.sources.find((x) => x.id === s.id);
      if (folderIssue && checked?.state === "active" && !sourceIssue(checked)) setVerified(true);
      return next;
    });
  if (verified && s.state === "active" && !issue)
    return (
      <div className="xw-recovery xw-folder-repair">
        <section>
          <Icon name="success" size={58} />
          <h1>Your folder is connected.</h1>
          <p>PackProof can read {title} again.</p>
          <button className="xw-primary" onClick={onBack}>
            Back to connections
          </button>
        </section>
        <aside className="xw-card xw-context">
          <span className="xw-badge xw-green">Connected</span>
          <h2>{title}</h2>
          <p>{s.folder}</p>
          <p>{s.recognition.message}</p>
        </aside>
      </div>
    );
  return (
    <>
      <button className="xw-link xw-back" onClick={onBack}>
        ‹ Back to connections
      </button>
      <div className={"xw-recovery" + (folderIssue ? " xw-folder-repair" : "")}>
        <section>
          <span className={"xw-badge " + (issue ? "xw-warn" : "xw-green")}>{sourceState(s)}</span>
          <h1>{folderIssue ? "Reconnect your " + primary + " folder." : title}</h1>
          <p>{issue || s.recognition.message}</p>
          {folderIssue && (
            <button
              className="xw-card xw-choice"
              disabled={busy}
              onClick={() =>
                bridge.replaceWorkspaceFolder
                  ? void run(() => bridge.replaceWorkspaceFolder!(s.id, s.generation))
                  : edit(primary)
              }
            >
              <Icon name="folder" size={38} />
              <span>
                <strong>Choose a readable folder</strong>
                <small>Select where your team saves these records.</small>
              </span>
            </button>
          )}
          {folderIssue && (
            <button className="xw-card xw-choice" aria-expanded={help} onClick={() => setHelp(!help)}>
              <Icon name="approval" size={38} />
              <span>
                <strong>Keep this folder and fix access</strong>
                <small>See what your team needs to check.</small>
              </span>
            </button>
          )}
          {help && (
            <p className="xw-notice">
              Make sure this folder is available to the PackProof Connect background service. Ask the folder
              owner for read access, then check again.
            </p>
          )}
          <div className="xw-btns">
            {!api && (
              <button className="xw-secondary" disabled={busy} onClick={() => void inspect()}>
                Check again
              </button>
            )}
            {["active", "paused"].includes(s.state) && (
              <button
                className="xw-secondary"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    s.state === "paused"
                      ? bridge.resumeWorkspaceSource(s.id)
                      : bridge.pauseWorkspaceSource(s.id),
                  )
                }
              >
                {s.state === "paused" ? "Resume collection" : "Pause collection"}
              </button>
            )}
            {api && s.state === "active" && (
              <button
                className="xw-secondary"
                disabled={busy}
                onClick={() =>
                  void run(() => bridge.copyWorkspaceDirectProfile(s.id), "Connection details copied.")
                }
              >
                Copy connection details for IT
              </button>
            )}
            {s.issue === "IDENTITY_UNRESOLVED" && (
              <button
                className="xw-secondary"
                disabled={busy}
                onClick={() => void run(() => bridge.openWorkspaceReview())}
              >
                Review source links online
              </button>
            )}
          </div>
          {!folderIssue && (
            <button className="xw-link" onClick={() => edit(primary)}>
              Edit source settings →
            </button>
          )}
          {s.state === "pending" && (
            <button className="xw-link" onClick={() => edit("activate")}>
              Review access and activate →
            </button>
          )}
          {s.recognition.state === "ambiguous" && (
            <div className="xw-card xw-clarify">
              <h3>{s.recognition.question || "Confirm this source"}</h3>
              {s.recognition.relatedChoices?.map((c) => (
                <div key={c.role}>
                  {c.options.map((o) => (
                    <button
                      className="xw-secondary"
                      key={o.id}
                      disabled={busy}
                      onClick={() =>
                        void run(() => bridge.chooseWorkspaceRelatedSource(s.id, s.generation, c.role, o.id))
                      }
                    >
                      {o.displayName}
                    </button>
                  ))}
                </div>
              ))}
              {!s.recognition.relatedChoices?.length && s.recognition.profileVersion && (
                <button
                  className="xw-secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      bridge.confirmWorkspaceOrderMap(s.id, s.generation, s.recognition.profileVersion!),
                    )
                  }
                >
                  Confirm this reference
                </button>
              )}
            </div>
          )}
        </section>
        <aside className="xw-card xw-context">
          <span className="xw-badge xw-blue">Connection details</span>
          <h2>{title}</h2>
          <p>{s.roles.map((r) => roles[r].title).join(" · ")}</p>
          <div className="xw-context-file">
            <Icon name={api ? "connection" : "folder"} size={38} />
            <small>{api ? "Upstream system" : "Selected folder"}</small>
            <strong>{api ? s.sourceNamespace || title : s.folder}</strong>
          </div>
          {s.lastScanAt && <p>Last checked {new Date(s.lastScanAt).toLocaleString()}</p>}
          <p>{s.recognition.message}</p>
        </aside>
      </div>
    </>
  );
}
