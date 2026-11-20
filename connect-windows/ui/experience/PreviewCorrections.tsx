import { useState } from "react";
import type { FacilityInputs } from "../guided-workflow-types";
import type { DraftPreview } from "../workspace-types";

type Example = DraftPreview["examples"][number];
type Edit = NonNullable<FacilityInputs["recordEdits"]>[number];
export function PreviewCorrections({ order, choices, onMove, onEditSource }: {
  order: Example; choices: Example[]; onMove: (edit: Edit) => void; onEditSource: () => void;
}) {
  const [record, setRecord] = useState("");
  const [target, setTarget] = useState("");
  const records = order.events.filter(e=>!e.shared && e.kind!=="order" && e.recordHash && e.sourceId);
  const others = choices.filter(e=>e.orderId && e.orderNamespace && (e.orderId!==order.orderId || e.orderNamespace!==order.orderNamespace));
  const item = records.find(e=>e.recordHash===record);
  const dest = others.find(e=>JSON.stringify([e.orderNamespace,e.orderId])===target);
  if (!order.orderId || !order.orderNamespace || !records.length) return null;
  return <details className="guided-form"><summary>Correct a match</summary>
    <label>Source record<select value={record} onChange={e => setRecord(e.target.value)}>
      <option value="">Select a record</option>
      {records.map(r=><option key={r.recordHash} value={r.recordHash}>{[r.fileName,r.locator,r.kind].filter(Boolean).join(" · ")}</option>)}
    </select></label>
    <label>Move it to this order in the preview<select value={target} onChange={e => setTarget(e.target.value)}>
      <option value="">Select a different order</option>
      {others.map(e=>{const key=JSON.stringify([e.orderNamespace,e.orderId]);return <option key={key} value={key}>{e.displayReference || e.orderReference} · {e.source}</option>;})}
    </select></label>
    {item && dest && <p>{item.fileName} · {order.displayReference || order.orderReference} → {dest.displayReference || dest.orderReference}</p>}
    <button type="button" className="setup-secondary" disabled={!item || !dest} onClick={()=>{
      if (item?.sourceId && item.recordHash && order.orderId && order.orderNamespace && dest?.orderNamespace && dest.orderId)
        onMove({sourceId:item.sourceId,recordHash:item.recordHash,fromSpace:order.orderNamespace,fromId:order.orderId,toSpace:dest.orderNamespace,toId:dest.orderId});
    }}>This record only</button>
    <small>This correction is for your preview. Live collection uses the tested source rules.</small>
    <button type="button" className="setup-link" onClick={onEditSource}>Edit the rule for this source</button>
  </details>;
}
