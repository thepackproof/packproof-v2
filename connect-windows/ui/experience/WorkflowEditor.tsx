import { useState } from "react";
import type { FacilityInputs } from "../guided-workflow-types";

type Step = FacilityInputs["steps"][number];
type Example = FacilityInputs["examples"][number];
export const exampleKinds = ["ordinary", "split", "reprint"] as const;
export const exampleNames = { ordinary: "Everyday order", split: "Split shipment", reprint: "Reprinted label" };
const scopeNames = { order: "Order", line: "Order line", carton: "Carton", shipment: "Shipment" };
const recordFields = { identifier: "Linking field", timeField: "Event time field", unit: "Unit", format: "Record format" };

export function ExpectationEditor({ examples, onChange }: {
  examples: Example[];
  onChange: (value: Example[]) => void;
}) {
  const [kind, setKind] = useState<Example["kind"]>("ordinary");
  const current = examples.find(e => e.kind === kind) ?? { kind, reference: "", cartons: null, labelCount: null };
  function update(value: Partial<Example>) {
    const next = { ...current, ...value };
    onChange([...examples.filter(e => e.kind !== kind), next]);
  }
  return <section className="setup-card guided-form">
    <label>Example to check<select value={kind} onChange={e => setKind(e.target.value as Example["kind"])}>
      {exampleKinds.map(k => <option key={k} value={k}>{exampleNames[k]}</option>)}
    </select></label>
    <label>Order, carton or shipment reference<input maxLength={160} autoComplete="off" value={current.reference}
      onChange={e => update({ reference: e.target.value })} placeholder="Enter a reference you know" /></label>
    <div className="guided-pair">
      <label>Expected cartons<input type="number" min={0} max={1000} placeholder="Unknown"
        value={current.cartons ?? ""} onChange={e => update({ cartons: e.target.value === "" ? null : e.target.valueAsNumber })} /></label>
      <label>Expected labels printed<input type="number" min={0} max={1000} placeholder="Unknown"
        value={current.labelCount ?? ""} onChange={e => update({ labelCount: e.target.value === "" ? null : e.target.valueAsNumber })} /></label>
    </div>
    <small>Record what you remember before opening the preview. These expectations stay separate from the order’s evidence.</small>
  </section>;
}

export function WorkflowEditor({ steps, onChange }: { steps: Step[]; onChange: (steps: Step[]) => void }) {
  const [selectedId, select] = useState<string | null>(null);
  const step = steps.find(s => s.id === selectedId);
  function changeStep(value: Partial<Step>) {
    onChange(steps.map(s => s.id === selectedId ? { ...s, ...value } : s));
  }
  function remove() {
    onChange(steps.filter(s => s.id !== selectedId).map(s => ({ ...s, after: s.after.filter(id => id !== selectedId) })));
    select(null);
  }
  function move(current: Step, offset: number) {
    const ordered = [...steps];
    const from = steps.indexOf(current), to = from + offset;
    [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
    onChange(ordered);
  }
  function add() {
    const id = "step-" + crypto.randomUUID();
    onChange([...steps, { id, name: "New step", scope: "carton", system: "", device: "", after: [], optional: false }]);
    select(id);
  }
  function addWeigh() {
    onChange([...steps, {id: "weigh", name: "Weigh each carton", scope: "carton", system: "", device: "", optional: false,
      after: steps.some(s => s.id === "pack") ? ["pack"] : [], record: {identifier: "Carton", timeField: "", unit: "", format: ""}}]);
    select("weigh");
  }
  return <section className="setup-card guided-form">
    <h3>Your warehouse workflow</h3>
    <ol className="guided-steps">{steps.map((s, i) => <li key={s.id}>
      <button type="button" className="setup-link" aria-expanded={s.id === selectedId}
        onClick={() => select(selectedId === s.id ? null : s.id)}>{s.name || "New step"}</button>
      <small>{scopeNames[s.scope]}{s.optional ? " · optional" : ""}</small>
      <button type="button" className="guided-arrow" aria-label={"Move " + s.name + " up"} disabled={!i} onClick={() => move(s,-1)}>↑</button>
      <button type="button" className="guided-arrow" aria-label={"Move " + s.name + " down"} disabled={i === steps.length - 1} onClick={() => move(s,1)}>↓</button>
    </li>)}</ol>
    {step && <fieldset className="guided-fields">
      <legend>Step details</legend>
      <label>What does your team call this step?<input value={step.name} maxLength={100} onChange={e => changeStep({ name: e.target.value })} /></label>
      <div className="guided-pair"><label>Applies to<select value={step.scope} onChange={e => changeStep({ scope: e.target.value as Step["scope"] })}>
        {(Object.keys(scopeNames) as Step["scope"][]).map(k => <option key={k} value={k}>{scopeNames[k]}</option>)}
      </select></label>
      <label>Responsible system<input value={step.system} maxLength={100} onChange={e => changeStep({ system: e.target.value })} placeholder="I’m not sure" /></label></div>
      <label>Device, if known<input value={step.device} maxLength={100} onChange={e => changeStep({ device: e.target.value })} placeholder="For example, a packing scale" /></label>
      <label className="guided-checkbox"><input type="checkbox" checked={step.optional} onChange={e => changeStep({ optional: e.target.checked })}/>Optional step</label>
      <details><summary>Records and dependencies</summary>
        {Object.entries(recordFields).map(([key, label]) => {
          const field = key as keyof NonNullable<Step["record"]>;
          return <label key={key}>{label}<input placeholder="I’m not sure" maxLength={100} value={step.record?.[field] ?? ""}
            onChange={e => changeStep({ record: { identifier: "", timeField: "", unit: "", format: "", ...step.record, [field]: e.target.value } })}/></label>;
        })}
        <fieldset><legend>Which steps must finish first?</legend>
          {steps.filter(s => s.id !== step.id).map(s => <label className="guided-checkbox" key={s.id}>
            <input type="checkbox" checked={step.after.includes(s.id)} onChange={e => changeStep({
              after: e.target.checked ? [...step.after,s.id] : step.after.filter(id => id !== s.id),
            })}/>{s.name || "New step"}</label>)}
        </fieldset>
      </details>
      <button className="setup-link" type="button" disabled={steps.length === 1} onClick={remove}>Remove this step</button>
    </fieldset>}
    <button type="button" className="setup-link" disabled={steps.length >= 32} onClick={add}>Add a step</button>
    {!steps.some(s => s.id === "weigh") && <button type="button" className="setup-link" disabled={steps.length >= 32} onClick={addWeigh}>Add carton weighing</button>}
  </section>;
}
