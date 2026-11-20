import { useState } from "react";
import type { FacilityInputs } from "../guided-workflow-types";
import type { WorkspaceSource } from "../workspace-types";
import { sourceName } from "./SetupParts";

type Rule = NonNullable<FacilityInputs["packing"]>[number];
export function PackingFieldEditor({ source, orders, current, onSave }: {
  source: WorkspaceSource; orders: WorkspaceSource[]; current?: Rule; onSave: (next?: Rule) => void;
}) {
  const [carton, setCarton] = useState(current?.cartonField ?? "");
  const [weight, setWeight] = useState(current?.weightField ?? "");
  const [unitField, setUnitField] = useState(current?.unitField ?? "");
  const [unitValue, setUnitValue] = useState(current?.unitValue ?? "");
  const [unit, setUnit] = useState<Rule["unit"]>(current?.unit);
  const [orderId, setOrderId] = useState(current?.orderSourceId ?? "");
  const headings = [...new Set(source.recognition.fields ?? [])];
  const schema = source.recognition.packingSchema;
  const ready = !!schema && headings.includes(carton) && orders.some(s => s.id === orderId) &&
    (!weight || headings.includes(weight) && weight !== carton) &&
    (!unit || weight && headings.includes(unitField) && unitField !== weight && unitValue.trim());
  function field(label: string, value: string, set: (v:string) => void) {
    return <label>{label}<select value={value} onChange={e => set(e.target.value)}>
      <option value="">Choose a field</option>{headings.map(h => <option key={h}>{h}</option>)}
    </select></label>;
  }
  if (!schema && !current) return null;
  return <details className="guided-form"><summary>Clarify carton and weight fields</summary>
    <p>Use the exact heading and order source for this packing export. A changed layout will need another check.</p>
    {field("Field that identifies this carton", carton,setCarton)}
    <label>System that owns the order reference<select value={orderId} onChange={e => setOrderId(e.target.value)}>
      <option value="">Choose an order source</option>{orders.map(s => <option key={s.id} value={s.id}>{sourceName(s)}</option>)}
    </select></label>
    {field("Recorded weight (optional)", weight,setWeight)}
    {weight && <>
      {field("Field containing the unit",unitField,setUnitField)}
      <label>Meaning of this unit<select value={unit ?? ""} onChange={e => setUnit((e.target.value || undefined) as Rule["unit"])}>
        <option value="">Unconfirmed</option>{["kg","g","lb","oz"].map(u => <option key={u}>{u}</option>)}
      </select></label>
      {unit && <label>Exact unit text in this export<input value={unitValue} maxLength={80}
        placeholder={source.recognition.sample?.[unitField] || "As written in the source"} onChange={e=>setUnitValue(e.target.value)}/></label>}
      {!unit && <small>PackProof preserves the reported value. Weight comparisons require a confirmed unit.</small>}
    </>}
    <button type="button" className="setup-secondary" disabled={!ready} onClick={() => {
      if (!schema || !ready) return;
      onSave({sourceId:source.id,orderSourceId:orderId,schema,cartonField:carton,
        ...(weight ? {weightField:weight} : {}), ...(weight && unitField ? {unitField} : {}),
        ...(weight && unit && unitField ? {unit,unitValue:unitValue.trim()} : {})});
    }}>Use this rule for this source</button>
    {current && <button type="button" className="setup-link" onClick={() => onSave()}>Remove packing rule</button>}
  </details>;
}
