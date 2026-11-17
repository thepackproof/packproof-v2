import { useEffect,useState } from "react";
import type { ConnectBridge } from "./types";
import type { AttentionReport, WorkspaceSource } from "./workspace-types";

export function WorkspaceAttention({bridge,sources}:{bridge:ConnectBridge;sources:WorkspaceSource[]}) {
  const [report,setReport]=useState<AttentionReport|null>(null);
  const [error,setError]=useState("");
  const [opening,setOpening]=useState(false);
  useEffect(()=>{
    let live=true,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      try{
        const current=await bridge.workspaceAttention();
        if(live){setReport(current);setError("");}
      }catch(e){if(live){setReport(null);setError(e instanceof Error?e.message:"Reconnect to check records awaiting an order reference.");}}
      if(live)timer=setTimeout(refresh,10000);
    };
    void refresh();
    return ()=>{live=false;clearTimeout(timer);};
  },[bridge]);
  return <section><h2>Records awaiting an order link</h2>
    {error ? <p role="alert">{error}</p> : !report ? <p role="status">Looking for records to review…</p> :
      report.items.length===0 ? <p>All checked records have an order link.</p> : <ul>{report.items.map((item,index)=>{
        const folder=sources.find(s=>s.id===item.sourceId)?.folder;
        return <li key={index}><strong>{item.fileName || "Source record"}</strong>
          {folder && <span> · {folder.split(/[\\/]/).filter(Boolean).at(-1)}</span>}
          {item.locator && <span> · {item.locator}</span>}</li>;
      })}</ul>}
    {report?.hasMore && <p>Open online review for the full list.</p>}
    {!!report?.items.length && <button className="secondary" disabled={opening} onClick={async()=>{
      setOpening(true);try{await bridge.openWorkspaceReview();}catch(e){setError(e instanceof Error?e.message:"Could not open online review.");}finally{setOpening(false);}
    }}>{opening ? "Opening review…" : "Review source links online"}</button>}
  </section>;
}

