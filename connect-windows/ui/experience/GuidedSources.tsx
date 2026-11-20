import { useState } from "react";
import type { FacilityDraft, FacilityInputs } from "../guided-workflow-types";
import type { ConnectStatus } from "../types";
import type { SourceRole, WorkspaceBridge, WorkspaceSource } from "../workspace-types";
import { FolderSuggestions } from "./FolderSuggestions";
import { Clarify } from "./SourceClarification";
import { roles, sourceName } from "./SetupParts";
import { SetupAssistant } from "./SetupAssistant";

const timingFields = {
  expectedCheckIntervalSeconds: { label: "Expected time between checks (minutes)", max: 1440 },
  expectedDeliveryAfterLabelSeconds: { label: "Delivery due after carton label (minutes)", max: 525600 },
};

export function GuidedSources({ bridge, draft, value, sources, busy, update, run, editWorkflow }: {
  bridge: WorkspaceBridge; draft: FacilityDraft; value: FacilityInputs; sources: WorkspaceSource[]; busy: boolean;
  update: (value: Partial<FacilityInputs>) => void;
  run: (action: () => Promise<ConnectStatus>) => void; editWorkflow: () => void;
}) {
  const [role, setRole] = useState<SourceRole>("order");
  const [search, setSearch] = useState(false);
  function toggle(source: WorkspaceSource) {
    const excluded = value.excludedSourceIds;
    update({ excludedSourceIds: excluded.includes(source.id) ? excluded.filter(id => id !== source.id) : [...excluded, source.id] });
  }
  const sourceKey = JSON.stringify(sources.map(s => [s.id, s.generation, s.recognition.fields]));
  return <>
    <section className="setup-card guided-form">
      <label>Which records should we look for?<select value={role} onChange={e => { setSearch(false); setRole(e.target.value as SourceRole); }}>
        {(Object.keys(roles) as SourceRole[]).map(key => <option key={key} value={key}>{roles[key].title}</option>)}
      </select></label>
      <p>Search the usual export locations available to the background service on this computer, or choose one dedicated folder.</p>
      {search ? <FolderSuggestions key={role} role={role} bridge={bridge} busy={busy}
        onChoose={folder => run(() => bridge.useWorkspaceFolderSuggestion!(role, folder))}/> :
        <button className="setup-secondary" type="button" onClick={() => setSearch(true)}>Search export locations</button>}
      <button className="setup-link" type="button" onClick={() => run(() => bridge.chooseWorkspaceFolder(role))}>Choose a folder</button>
      {role === "order" && <details><summary>Use a connected order system</summary>
        <p>Use your existing PackProof Partner API integration.</p>
        <button className="setup-link" type="button" onClick={() => run(() => bridge.addWorkspaceDirectSource())}>Select the Partner API connection</button>
      </details>}
    </section>
    {sources.map(source => {
      const r = source.recognition;
      const excluded = value.excludedSourceIds.includes(source.id);
      const headings = [...new Set([...(r.fields ?? []), ...Object.keys(r.sample ?? {})])];
      const shippedAt = headings.find(h => h.trim().toLowerCase() === "shipped at");
      const rule = value.rules.find(rule => rule.sourceId === source.id);
      const read = draft.replay?.sources.find(s => s.sourceId === source.id);
      const timing = value.timing?.find(t => t.sourceId === source.id);
      return <section key={source.id} className="setup-card guided-form">
        <h3>{sourceName(source)}</h3>
        <p>{excluded ? "Set up later · excluded from this proposal" : r.message}</p>
        {!excluded && <>
          <Clarify source={source} bridge={bridge} busy={busy} apply={run}/>
          {shippedAt && <label>When does “{shippedAt}” get filled in?
            <select value={rule?.shippedAt ?? ""} onChange={e => update({
              rules: [...value.rules.filter(item => item.sourceId !== source.id), {sourceId: source.id, shippedAt: e.target.value as FacilityInputs["rules"][number]["shippedAt"]}],
            })}>
              <option disabled value="">Choose a meaning</option><option value="label">When a label is printed</option>
              <option value="handoff">When the carrier takes it</option><option value="unknown">I’m not sure</option>
            </select>
          </label>}
          <details><summary>Fields and access</summary>
            <p>{source.folder || "Partner API"} · Generation {source.generation}</p>
            <p>{r.profileVersion ? "Reader profile " + r.profileVersion : "No confirmed reader profile"}</p>
            {headings.length > 0 && <p>{headings.join(" · ")}</p>}
            <p>{read ? read.message : "Background read will be checked during replay."}</p>
            {(Object.keys(timingFields) as (keyof typeof timingFields)[]).map(field => {
              if (field === "expectedDeliveryAfterLabelSeconds" && !source.roles.includes("delivery")) return null;
              const seconds = timing?.[field];
              return <label key={field}>{timingFields[field].label}
                <input type="number" min={1} max={timingFields[field].max} step={1} placeholder="No timing rule"
                  value={seconds === undefined ? "" : seconds / 60} onChange={e => {
                    const rest = (value.timing ?? []).filter(t => t.sourceId !== source.id);
                    const next = { ...timing, sourceId: source.id };
                    if (!e.target.value) delete next[field];
                    else next[field] = Math.round(e.target.valueAsNumber * 60);
                    update({ timing: next.expectedCheckIntervalSeconds !== undefined || next.expectedDeliveryAfterLabelSeconds !== undefined ? [...rest,next] : rest });
                  }}/>
              </label>;
            })}
            {source.transport !== "api" && <button type="button" className="setup-link" onClick={() => run(() => bridge.inspectWorkspaceSource(source.id))}>Check this source again</button>}
          </details>
        </>}
        <button type="button" className="setup-link" onClick={() => toggle(source)}>{excluded ? "Include this source" : "Set up later"}</button>
      </section>;
    })}
    {sources.length > 0 && !busy && value.rules === draft.rules && value.steps === draft.steps && value.excludedSourceIds === draft.excludedSourceIds &&
      <SetupAssistant key={draft.id + draft.revision + sourceKey} draft={draft} sources={sources} onChange={update} onEdit={editWorkflow}/>}
  </>;
}
