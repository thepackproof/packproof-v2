import { useEffect, useState } from "react";
import type { ConnectBridge } from "./types";
import type { DraftPreview, OrderDetail, OrderSummary, WorkspaceSource } from "./workspace-types";

const readable = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").trim();
const stageLabels: Record<string,string> = {order:"Order received",picking:"Picking recorded",packing:"Packing recorded",evidence:"Evidence captured",label:"Label created",handoff:"Handed off",delivery:"Delivery recorded",return:"Return recorded",correction:"Record corrected"};
const eventLabel = (value: string) => stageLabels[value] || readable(value);
const cell = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" || typeof value === "number") return String(value);
  }
  return "";
};

export function ExampleFields({sample}: {sample?: Record<string, string>}) {
  const labels:Record<string,string>={order:"Order",ordernumber:"Order number",orderreference:"Order",orderid:"Order",shipmentreference:"Shipment",shipmentid:"Shipment",packageid:"Package",sku:"Item",itemtitle:"Item",quantity:"Quantity",orderedquantity:"Ordered",pickedquantity:"Picked",packedquantity:"Packed",shippedquantity:"Shipped",unit:"Unit",carrier:"Carrier",trackingnumber:"Tracking",weight:"Weight",lineid:"Line",item:"Item",occurredat:"Recorded at"};
  const fields = Object.entries(sample || {}).filter(([key,value]) => labels[key.toLowerCase().replace(/[^a-z]/g,"")] && typeof value==="string" && value!=="")
    .slice(0,6).map(([key,value])=>[labels[key.toLowerCase().replace(/[^a-z]/g,"")],value]);
  return fields.length ? <dl className="ws-facts">{fields.map(([name,value]) =>
    <div key={name}><dt>{readable(name)}</dt><dd>{value}</dd></div>)}</dl> : null;
}

export function OrderView({order,sourceNames={}}: {order: OrderDetail;sourceNames?:Record<string,string>}) {
  const packages = new Set<string>();
  for(const event of order.events || []) {
    const references = Array.isArray(event.references) ? event.references : [];
    for(const reference of [event.entity,...references])
      if(reference && typeof reference === "object" && reference.type==="package" && typeof reference.id==="string")packages.add(reference.id);
  }
  for(const p of order.packages || []){const id=cell(p,["packageReference","packageId","externalId"]);if(id)packages.add(id);}
  return <article className="ws-record" aria-label={"Order " + order.orderReference}>
    <h2>{order.orderReference}</h2>
    <p className="ws-caption">Saved online · Revision {order.revision}</p>
    <h3>Items</h3>
    {order.lines?.length ? <ul>{order.lines.map((line,i) => {
      const item = cell(line, ["title","itemTitle","sku","itemId"]) || "Item";
      const quantity = cell(line, ["orderedQuantity","quantity","ordered"]);
      const lineId = cell(line, ["lineId","orderLineId","lineReference"]);
      const unit = cell(line, ["unit","uom"]);
      const results = [["Picked","pickedQuantity"],["Packed","packedQuantity"],["Shipped","shippedQuantity"],["Returned","returnedQuantity"]]
        .map(([label,key])=>({label,value:cell(line,[key])})).filter(x=>x.value!=="");
      return <li key={i}><strong>{item}</strong>{lineId && " · Line " + lineId}{quantity !== "" && " · Ordered " + quantity + (unit ? " " + unit : "")}
        {results.map(x=><span key={x.label}> · {x.label} {x.value}{unit && " " + unit}</span>)}</li>;
    })}</ul> : <p>Item details have not arrived.</p>}
    {!!packages.size && <><h3>Packages</h3><p>{[...packages].join(" · ")}</p></>}
    {!!order.conflicts?.length && <p className="ws-warning">Sources disagree on {order.conflicts.length} reported {order.conflicts.length===1 ? "value" : "values"}. Review the source evidence.</p>}
    <h3>Timeline</h3>
    {order.events?.length ? <ol className="ws-timeline">{order.events.map((event,i) => {
      const source = sourceNames[cell(event,["sourceId"])] || cell(event,["sourceName","sourceLabel","sourceNamespace","fileName"]);
      const time = cell(event,["occurredAt","observedAt"]);
      return <li key={i}><strong>{eventLabel(cell(event,["label","eventType","kind","stage","type"]) || "Observation")}</strong>{source && <span>{source}</span>}{time && <time>{time}</time>}</li>;
    })}</ol> : <p>Waiting for the first recorded event.</p>}
    <h3>Source evidence</h3>
    {order.evidence?.length ? <ul>{order.evidence.map((item,i) =>
      <li key={i}>{cell(item,["fileName","name","sourceName","mediaType"]) || "Source record"}{item.kind==="derived_excerpt" && " · Excerpt"}
        {sourceNames[cell(item,["sourceId"])] && " · " + sourceNames[cell(item,["sourceId"])]}</li>)}</ul> : <p>No evidence files on this revision.</p>}
    <details><summary>Technical details</summary><dl className="ws-facts"><div><dt>Proof ID</dt><dd>{order.proofId}</dd></div><div><dt>Revision</dt><dd>{order.revision}</dd></div></dl></details>
  </article>;
}

export function Orders({list, bridge,sources=[],searchable=false}: {list: OrderSummary[]; bridge: ConnectBridge;sources?:WorkspaceSource[];searchable?:boolean}) {
  const [input,setInput]=useState("");
  const [search,setSearch]=useState("");
  const [results,setResults]=useState<OrderSummary[]|null>(null);
  const [searchError,setSearchError]=useState("");
  useEffect(()=>{
    let live=true;
    setSearchError("");setResults(null);
    if(search)void bridge.workspaceSearchOrders(search).then(rows=>{if(live)setResults(rows);}).catch(e=>{
      if(live)setSearchError(e instanceof Error?e.message:"Reconnect to search your orders.");
    });
    return ()=>{live=false;};
  },[bridge,search]);
  const visible=search ? (results || []).map(row=>{
    const newer=list.find(recent=>recent.proofId===row.proofId && recent.revision>row.revision);
    return newer || row;
  }) : list;
  const [selected,setSelected] = useState<OrderSummary|null>(null);
  const [detail,setDetail] = useState<OrderDetail|null>(null);
  const [message,setMessage] = useState("");
  const [attempt,setAttempt] = useState(0);
  const refreshed = visible.find(item=>item.proofId===selected?.proofId);
  const current = refreshed && selected && refreshed.revision>selected.revision ? refreshed : selected;
  useEffect(()=>{if(current && selected && current.revision>selected.revision)setSelected(current);},[current,selected]);
  useEffect(() => {
    let live = true;
    setMessage("");
    setDetail(null);
    if (current) {
      const {proofId,revision} = current;
      void bridge.workspaceOrderDetail(proofId,revision).then(result => {
        if (!live) return;
        if (result.proofId !== proofId || result.revision !== revision) throw Error("This order changed. Choose its latest revision.");
        setDetail(result);
      }).catch(error => { if (live) setMessage(error instanceof Error ? error.message : "Reconnect to load this order."); });
    }
    return () => {live = false;};
  }, [bridge,current?.proofId,current?.revision,attempt]);

  return <div>
    {searchable && <form className="ws-actions" onSubmit={e=>{e.preventDefault();setSelected(null);setSearch(input.trim());}}>
      <label>Order reference<input maxLength={200} value={input} onChange={e=>setInput(e.target.value)}/></label>
      <button className="secondary" disabled={!input.trim()}>Find order</button>
      {search && <button type="button" className="quiet" onClick={()=>{setInput("");setSearch("");setSelected(null);}}>Show recent orders</button>}
    </form>}
    {searchError && <p role="alert">{searchError}</p>}
    {!visible.length && !searchError && <p role="status">{search ? results===null ? "Finding your order…" : "No order with that reference was found." : "Waiting for the first order."}</p>}
    <ul className="ws-orders">{visible.map(item => <li key={item.proofId}>
      <button className="ws-order-link" aria-pressed={selected?.proofId===item.proofId} onClick={()=>setSelected(item)}>
        <strong>{item.orderReference}</strong><span>Revision {item.revision}</span></button>
    </li>)}</ul>
    {current && (message ? <div role="alert">{message} <button className="quiet" onClick={()=>setAttempt(attempt+1)}>Retry</button></div> :
      detail && detail.revision === current.revision && detail.proofId === current.proofId ? <><OrderView order={detail} sourceNames={Object.fromEntries(sources.map(s=>[s.id,s.folder.split(/[\\/]/).filter(Boolean).at(-1) || s.folder]))}/>
        {detail.totals && (detail.totals.events>detail.events.length || detail.totals.lines>detail.lines.length || detail.totals.evidence>detail.evidence.length) &&
          <p>The desktop preview shows a selection from this revision. Open the online order for the complete record.</p>}
        <button className="secondary" onClick={()=>void bridge.openWorkspaceOrder(detail.proofId,detail.revision).catch(e=>setMessage(e instanceof Error?e.message:"Could not open the online order."))}>Open online order</button></> : <p role="status">Loading order…</p>)}
  </div>;
}

export function DraftOrderPreview({bridge,sources}: {bridge:ConnectBridge;sources:WorkspaceSource[]}) {
  const [preview,setPreview] = useState<DraftPreview|null>(null);
  const [message,setMessage] = useState("");
  const [attempt,setAttempt] = useState(0);
  const [index,setIndex] = useState(0);
  const scope = sources.map(s=>s.id + "/" + s.generation).join(",");
  useEffect(()=>{
    let live=true;
    setPreview(null);setMessage("");setIndex(0);
    void bridge.workspaceDraftPreview().then(result=>{if(live)setPreview(result);})
      .catch(e=>{if(live)setMessage(e instanceof Error ? e.message : "The order preview is unavailable. Check your folders.");});
    return ()=>{live=false;};
  },[bridge,scope,attempt]);
  const selected=preview?.examples[index];
  return <section aria-label="Local order preview">
    {message ? <p role="alert">{message} <button className="quiet" onClick={()=>setAttempt(attempt+1)}>Check again</button></p> :
      !preview ? <p role="status">Checking selected folders for a related order…</p> :
      selected ? <>
        {preview.examples.length>1 && <label>Example order<select value={index} onChange={e=>setIndex(Number(e.target.value))}>
          {preview.examples.map((example,i)=><option key={i} value={i}>{example.orderReference} · {example.source}</option>)}
        </select></label>}
        <h2>{selected.orderReference}</h2><p className="ws-caption">Local preview · {selected.source}</p>
        {!!selected.lines.length && <><h3>Items</h3><ul>{selected.lines.map((line,i)=><li key={i}>{line.sku || "Item"} · Line {line.lineId}{line.quantity && " · " + line.quantity + " " + (line.unit || "ordered")}</li>)}</ul></>}
        {!!selected.packages.length && <><h3>Packages</h3><p>{selected.packages.join(" · ")}</p></>}
        {!!selected.events.length && <><h3>Timeline</h3><ol className="ws-timeline">{selected.events.map((event,i)=><li key={i}>
          <strong>{eventLabel(event.kind)}</strong><span>{event.source} · {event.fileName}{event.shared && " · Shared shipment"}</span>
          {event.occurredAt && <time>{event.occurredAt}</time>}</li>)}</ol></>}
      </> : <p>Waiting for the first order.</p>}
    {preview && <><p className="ws-caption">Checked {preview.scannedFiles} {preview.scannedFiles===1 ? "file" : "files"} in the selected locations.{preview.limited && " Showing a bounded sample."}</p>
      {preview.unresolved>0 && <p className="ws-warning">{preview.unresolved} {preview.unresolved===1 ? "record needs" : "records need"} an order reference.</p>}
      {preview.unreadFiles>0 && <p className="ws-warning">Some selected files could not provide order details.</p>}</>}
  </section>;
}