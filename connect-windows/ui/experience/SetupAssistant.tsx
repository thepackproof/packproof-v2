import { useState } from "react";
import type { FacilityDraft, FacilityInputs } from "../guided-workflow-types";
import type { WorkspaceSource } from "../workspace-types";

const assistantSteps = ["release", "pick", "pack", "weigh", "label", "handoff", "delivery", "return"];
const labels = ["Shipped At", "Carton", "Weight", "Unit", "Order", "Tracking", "Delivered At"] as const;
type Label = typeof labels[number] | "Other";
type Field = { handle: string; label: Label; type: "text" | "number" | "datetime" };
type Suggestion = { operation: "ask_question" | "map_field" | "suggest_step" | "mark_unknown"; step: string; field: string | null;
  meaning: "label_printed" | "carrier_handoff" | "carton_weight" | "delivery" | "unknown";
  reason: "ambiguous_time" | "recognized_field" | "missing_unit" | "missing_step" };
interface Assistant { suggest(input: { draftId: string; revision: number; consent: true; steps: string[]; fields: Field[] }):
  Promise<{ revision: number; suggestions: Suggestion[] }> }
const meanings = { label_printed: "a label print", carrier_handoff: "a carrier handoff", carton_weight: "a carton weight", delivery: "a delivery", unknown: "unconfirmed" };
const reasons = { ambiguous_time: "This time can describe more than one event.", recognized_field: "The field matches a known heading.",
  missing_unit: "The unit needs confirmation.", missing_step: "The workflow may be missing a step." };

export function assistantFields(sources: WorkspaceSource[], excluded: string[]) {
  const origins = new Map<string, string>();
  const fields: Field[] = [];
  for (const source of sources.filter(s => !excluded.includes(s.id))) {
    const headings = new Set([...(source.recognition.fields ?? []), ...Object.keys(source.recognition.sample ?? {})]);
    for (const heading of headings) {
      if (fields.length >= 64) break;
      const label: Label = labels.find(l => l.toLowerCase() === heading.trim().toLowerCase()) ?? "Other";
      const handle = "f" + (fields.length + 1);
      origins.set(handle, source.id);
      fields.push({ handle, label, type: label === "Weight" ? "number" : label.endsWith(" At") ? "datetime" : "text" });
    }
  }
  return { fields, origins };
}

export function SetupAssistant({ draft, sources, onChange, onEdit }: {
  draft: FacilityDraft; sources: WorkspaceSource[]; onChange: (value: Partial<FacilityInputs>) => void; onEdit: () => void;
}) {
  const assistant = (window as Window & { packproofSetupAssistant?: Assistant }).packproofSetupAssistant;
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<Suggestion[]>([]);
  const [message, setMessage] = useState("");
  const { fields, origins } = assistantFields(sources, draft.excludedSourceIds);
  const steps = draft.steps.map(s => s.id).filter(id => assistantSteps.includes(id));
  async function ask() {
    if (!assistant || !consent || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await assistant.suggest({ draftId: draft.id, revision: draft.revision, consent: true, steps, fields });
      if (result.revision !== draft.revision) throw Error("The draft changed. Review the current fields and try again.");
      setResponse(result.suggestions);
      if (!result.suggestions.length) setMessage("There are no suggestions. You can continue with the manual choices.");
    } catch { setMessage("The assistant is unavailable for this draft. Continue with the manual choices."); }
    finally { setBusy(false); }
  }
  const suggestion = response[0];
  const field = fields.find(f => f.handle === suggestion?.field);
  const sourceId = field && origins.get(field.handle);
  const map = suggestion?.operation === "map_field" && field?.label === "Shipped At" && sourceId &&
    ["label_printed","carrier_handoff"].includes(suggestion.meaning);
  const addWeigh = suggestion?.operation === "suggest_step" && suggestion.step === "weigh" && !draft.steps.some(s => s.id === "weigh");
  function accept() {
    if (map && sourceId) {
      onChange({ rules: [...draft.rules.filter(r => r.sourceId !== sourceId), { sourceId, shippedAt: suggestion.meaning === "label_printed" ? "label" : "handoff" }] });
    } else if (addWeigh) {
      onChange({ steps: [...draft.steps, { id: "weigh", name: "Weigh each carton", scope: "carton", system: "", device: "", optional: false,
        after: draft.steps.some(s => s.id === "pack") ? ["pack"] : [], record: { identifier: "Carton", timeField: "", unit: "", format: "" } }] });
    } else { onEdit(); }
    setResponse(response.slice(1));
  }
  return <details className="setup-partner guided-form"><summary>Get setup suggestions</summary>
    <p>Only the following field descriptions and standard workflow steps are sent when you ask for help.</p>
    <ul>{fields.map(f => <li key={f.handle}>{f.handle} · {f.label} · {f.type}</li>)}</ul>
    <p>{steps.join(" · ") || "No standard steps selected"}</p>
    {assistant ? <>
      <label className="guided-checkbox"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)}/>Allow this setup request</label>
      <button className="setup-secondary" type="button" disabled={!consent || busy} onClick={() => void ask()}>{busy ? "Checking fields…" : "Suggest a setup choice"}</button>
    </> : <p>Manual setup is available on this installation.</p>}
    {message && <p role="status">{message}</p>}
    {suggestion && <div className="setup-card">
      <strong>{field ? field.label+" · " : ""}{suggestion.step}</strong>
      <p>{reasons[suggestion.reason]} {suggestion.meaning !== "unknown" && "Possible meaning: " + meanings[suggestion.meaning] + "."}</p>
      <div className="setup-actions">
        <button type="button" className="setup-secondary" onClick={accept}>{map || addWeigh ? "Accept suggestion" : "Review manually"}</button>
        <button type="button" className="setup-link" onClick={onEdit}>Edit manually</button>
        <button type="button" className="setup-link" onClick={() => setResponse(response.slice(1))}>Dismiss</button>
      </div>
    </div>}
  </details>;
}
