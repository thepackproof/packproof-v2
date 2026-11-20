import { useRef, useState } from "react";
import type { FacilityDraft, FacilityInputs } from "../guided-workflow-types";
import type { WorkspaceSource } from "../workspace-types";
import { standardWorkflowStep } from "./WorkflowEditor";
import { sourceName } from "./SetupParts";

const assistantSteps = ["release", "pick", "pack", "weigh", "label", "handoff", "delivery", "return"];
const labels = ["Shipped At", "Carton", "Weight", "Unit", "Order", "Tracking", "Delivered At"] as const;
type Label = typeof labels[number] | "Other";
type Field = { handle: string; label: Label; type: "text" | "number" | "datetime" };
type Suggestion = { operation: "ask_question" | "map_field" | "suggest_step" | "mark_unknown"; step: string; field: string | null;
  meaning: "label_printed" | "carrier_handoff" | "carton_weight" | "delivery" | "unknown";
  reason: "ambiguous_time" | "recognized_field" | "missing_unit" | "missing_step" };
type Decision = "accepted" | "edited" | "rejected";
type ShippedMeaning=FacilityInputs["rules"][number]["shippedAt"];
export type ManualReview = { sourceId?:string; field?:Label; revision:number; report:()=>void };
interface Assistant {
  suggest(input: { draftId: string; revision: number; consent: true; steps: string[]; fields: Field[] }):
    Promise<{ requestId:string; revision: number; suggestions: Suggestion[] }>;
  review?(input:{draftId:string; revision:number; requestId:string; index:number; decision:Decision}):Promise<void>;
}
const meanings = { label_printed: "a label print", carrier_handoff: "a carrier handoff", carton_weight: "a carton weight", delivery: "a delivery", unknown: "unconfirmed" };
const reasons = { ambiguous_time: "This time can describe more than one event.", recognized_field: "The field matches a known heading.",
  missing_unit: "The unit needs confirmation.", missing_step: "The workflow may be missing a step." };

function ShippingMeaningChoice({source, proposed, confirm}:{source:WorkspaceSource;proposed?:ShippedMeaning;confirm:(choice:ShippedMeaning)=>void}) {
  const [choice,setChoice]=useState<ShippedMeaning|"">(proposed ?? "");
  return <div className="guided-form"><label>What does Shipped At mean in {sourceName(source)}?
    <select value={choice} onChange={e=>setChoice(e.target.value as ShippedMeaning)}>
      <option disabled value="">Choose a meaning</option>
      <option value="label">A label was printed</option>
      <option value="handoff">The carrier took possession</option>
      <option value="unknown">We cannot confirm what happened</option>
    </select></label>
    <button type="button" className="setup-secondary" disabled={!choice} onClick={()=>{if(choice)confirm(choice);}}>Use this meaning for this source</button>
  </div>;
}

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
  draft: FacilityDraft; sources: WorkspaceSource[]; onChange: (value: Partial<FacilityInputs>) => void; onEdit: (review:ManualReview) => void;
}) {
  const assistant = (window as Window & { packproofSetupAssistant?: Assistant }).packproofSetupAssistant;
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<{index:number;requestId:string;suggestion:Suggestion}[]>([]);
  const reported = useRef(new Set<string>());
  const [message, setMessage] = useState("");
  const { fields, origins } = assistantFields(sources, draft.excludedSourceIds);
  const steps = draft.steps.map(s => s.id).filter(id => assistantSteps.includes(id));
  async function ask() {
    if (!assistant || !consent || busy) return;
    setBusy(true);
    setMessage("");
    setResponse([]);
    try {
      const result = await assistant.suggest({ draftId: draft.id, revision: draft.revision, consent: true, steps, fields });
      if (result.revision !== draft.revision) throw Error("The draft changed. Review the current fields and try again.");
      setResponse(result.suggestions.map((suggestion,index)=>({suggestion,index,requestId:result.requestId})));
      if (!result.suggestions.length) setMessage("There are no suggestions. You can continue with the manual choices.");
    } catch { setMessage("The assistant is unavailable for this draft. Continue with the manual choices."); }
    finally { setBusy(false); }
  }
  const entry = response[0];
  const suggestion = entry?.suggestion;
  const field = fields.find(f => f.handle === suggestion?.field);
  const sourceId = field && origins.get(field.handle);
  const map = field?.label === "Shipped At" && sourceId && (
    suggestion?.operation === "map_field" && ["label_printed","carrier_handoff"].includes(suggestion.meaning) ||
    suggestion?.operation === "mark_unknown" && suggestion.meaning === "unknown"
  );
  const addStep = suggestion?.operation === "suggest_step" ? standardWorkflowStep(suggestion.step,draft.steps) : undefined;
  const boundSource = sources.find(s=>s.id===sourceId);
  const clarifyTime=!!boundSource && field?.label==="Shipped At" && (map || suggestion?.operation==="ask_question");
  const proposed:ShippedMeaning|undefined=map ? suggestion.meaning==="label_printed"?"label":suggestion.meaning==="carrier_handoff"?"handoff":"unknown" : undefined;
  const timeStep = suggestion?.operation==="map_field" && suggestion.meaning==="delivery" && field?.label==="Delivered At" &&
    boundSource?.roles.includes("delivery") && draft.steps.find(s=>s.id===suggestion.step);
  const sourcePacking= draft.packing?.find(p=>p.sourceId===sourceId);
  const weightField = suggestion?.operation==="map_field" && suggestion.meaning==="carton_weight" &&
    field?.label==="Weight" && sourcePacking && boundSource?.recognition.fields?.find(f=>f.trim().toLowerCase()==="weight");
  function report(decision:Decision) {
    if (!entry?.requestId || !assistant?.review) return;
    const key = entry.requestId + "/" + entry.index;
    if (reported.current.has(key)) return;
    reported.current.add(key);
    void assistant.review({draftId:draft.id,revision:draft.revision,requestId:entry.requestId,index:entry.index,decision}).catch(()=>{});
  }
  function editManually() {
    onEdit({sourceId,field:field?.label,revision:draft.revision,report:()=>report("edited")});
    setResponse(response.slice(1));
  }
  function accept() {
    if (addStep) {
      report("accepted");
      onChange({steps:[...draft.steps,addStep]});
    } else if(timeStep && boundSource) {
      report("accepted");
      const heading=boundSource.recognition.fields?.find(f=>f.trim().toLowerCase()==="delivered at") ?? "Delivered At";
      onChange({steps:draft.steps.map(s=>s.id===timeStep.id?{...s,record:{identifier:"",unit:"",format:"",...s.record,timeField:heading}}:s)});
    } else if(weightField && sourcePacking) {
      report("accepted");
      onChange({packing:draft.packing?.map(p=>p.sourceId===sourceId?{...p,weightField}:p)});
    } else { editManually(); return; }
    setResponse(response.slice(1));
  }
  return <details className="setup-partner guided-form"><summary>Get setup suggestions</summary>
    <p>Review the field descriptions and standard steps for draft revision {draft.revision}. This request is scoped to the signed-in facility.</p>
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
      {clarifyTime && boundSource && <ShippingMeaningChoice key={entry.requestId+":"+entry.index} source={boundSource} proposed={proposed}
        confirm={shippedAt=>{
          onChange({rules:[...draft.rules.filter(r=>r.sourceId!==boundSource.id),{sourceId:boundSource.id,shippedAt}]});
          report(shippedAt===proposed?"accepted":"edited");
          setResponse(response.slice(1));
        }}/>}
      <div className="setup-actions">
        {!clarifyTime && (addStep || timeStep || weightField) && <button type="button" className="setup-secondary" onClick={accept}>Accept suggestion</button>}
        {!clarifyTime && <button type="button" className="setup-link" onClick={editManually}>Edit manually</button>}
        <button type="button" className="setup-link" onClick={() => {report("rejected");setResponse(response.slice(1));}}>Dismiss</button>
      </div>
    </div>}
  </details>;
}
