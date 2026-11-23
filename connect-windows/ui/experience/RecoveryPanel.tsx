import type { ConnectStatus } from "../types";
import type { WorkspaceSource } from "../workspace-types";
import type { RunAction, WorkspaceProps } from "./WorkspaceModel";
import { canReadWorkspace, sourceIssue, sourceTitle, sourceState } from "./WorkspaceModel";
import { Icon } from "./Icon";
import "./RecoveryPanel.css";

type Props = {
  status: ConnectStatus;
  sources: WorkspaceSource[];
  busy: boolean;
  run: RunAction;
  bridge: WorkspaceProps["bridge"];
  onSource: (id: string) => void;
};
const dateTime = (value?:string|null) => {
  if(!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});
};

/**
 * Figma 4:410 — actual LocalService recovery and protection state.
 * "Retrying", "healthy", queued count and reconnect time must be justified
 * by service observations. Never replace a blocked source with a green badge.
 */
export function RecoveryPanel({status,sources,busy,run,bridge,onSource}:Props) {
  const canInspect = canReadWorkspace(status);
  const queue = status.health.queueCount;
  const output = status.proofOutput;
  const active = canInspect ? sources.filter(s=>s.state === "active").length : 0;
  const problem = canInspect ? sources.filter(s=>!!sourceIssue(s)).length : 0;
  const needsOutput = (output?.pending ?? 0)>0 || ["access_denied","unavailable"].includes(output?.state ?? "");
  const attention = !canInspect || problem>0 || (queue !== null && queue !== undefined && queue>0) || needsOutput;
  const headline = !status.health.serviceOnline ? "Background collector unavailable" :
    !canInspect ? "Facility authorization needs attention" :
    problem>0 ? (problem===1 ? "One connection needs attention" : problem+" connections need attention") :
    needsOutput ? "Local Proof copies require attention" :
    queue !== null && queue !== undefined && queue>0 ? "Protected work is waiting to be processed" :
    "Current collection state";
  const subscriptions = canInspect ? status.sourceSubscriptions ?? [] : [];
  const nextRetry = subscriptions.map(s=>s.nextPublicationCheckAt)
    .filter((s):s is string=>!!s && Number.isFinite(Date.parse(s))).sort()[0];
  return (
    <section className={"eo-recovery " + (attention ? "eo-recovery-attention" : "")}
      aria-label="Collection and recovery status"
      data-design-file="nNnkgTZOBNkG8muy8AkIv1" data-design-node="4:410">
      <div className="eo-recovery-hero">
        <span className="eo-recovery-symbol"><Icon name={attention ? "attention" : "sync"} size={32}/></span>
        <div className="eo-recovery-copy">
          <span className="eo-recovery-kicker">AUTONOMOUS COLLECTION / OBSERVED STATUS</span>
          <h2>{headline}</h2>
          <p>{canInspect
            ? "Source collection, protected queue state and output publication are monitored separately."
            : "Restore the background service and approved facility connection before viewing current source records."}</p>
          {nextRetry && canInspect && <small>Next scheduled source check: {dateTime(nextRetry)}</small>}
        </div>
        <button type="button" className="eo-recovery-refresh" disabled={busy}
          onClick={() => void run(() => bridge.getWorkspaceStatus())}>Refresh actual status</button>
      </div>
      <div className="eo-recovery-grids">
        <section className="eo-recovery-panel">
          <div className="eo-recovery-panel-head"><h3>Connected systems</h3><span>{canInspect ? active + " collecting" : "Access unavailable"}</span></div>
          {canInspect && sources.length ? (
            <div className="eo-recovery-sources">
              {sources.slice(0,5).map(source=>{
                const issue=sourceIssue(source);
                return <button key={source.id} type="button" className="eo-recovery-source"
                  disabled={busy} onClick={()=>onSource(source.id)}>
                  <span className={"eo-recovery-dot " + (issue ? "has-issue" : source.state==="active" ? "is-active" : "")}/>
                  <span><strong>{sourceTitle(source)}</strong>
                    <small>{issue || (source.lastScanAt ? "Last checked " + dateTime(source.lastScanAt) : "Last scan not reported")}</small></span>
                  <em>{sourceState(source)}</em>
                </button>;
              })}
            </div>
          ) : <p className="eo-recovery-empty">{canInspect
              ? "No approved connected sources have been reported."
              : "Source details are hidden while current access cannot be confirmed."}</p>}
        </section>
        <section className="eo-recovery-panel">
          <div className="eo-recovery-panel-head"><h3>Durable recovery</h3><span>Actual service data</span></div>
          <div className="eo-recovery-stat">
            <span className="eo-recovery-status-icon"><Icon name="records" size={22}/></span>
            <span><strong>Protected local queue</strong><small>Items reported by the collector</small></span>
            <b>{queue ?? "—"}</b>
          </div>
          <div className="eo-recovery-stat">
            <span className="eo-recovery-status-icon"><Icon name="folder" size={22}/></span>
            <span><strong>Local Proof copies</strong><small>{output?.state ? "Output state: "+output.state.replaceAll("_"," ") : "Output state not reported"}</small></span>
            <b>{output?.pending ?? "—"} <small>pending</small></b>
          </div>
          <div className="eo-recovery-stat">
            <span className="eo-recovery-status-icon"><Icon name="sync" size={22}/></span>
            <span><strong>Collector service</strong><small>{status.health.lastErrorCode || "No service error code reported"}</small></span>
            <b>{status.health.serviceOnline ? "Online" : "Offline"}</b>
          </div>
          <p className="eo-recovery-disclosure">A queued item is not a completed Proof. Exact source authority and successful backend receipt are required before evidence is accepted.</p>
        </section>
      </div>
    </section>
  );
}
