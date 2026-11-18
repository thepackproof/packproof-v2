import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";
import type { SourceRole, WorkspaceSource } from "../workspace-types";

export const roles: Record<SourceRole, { title: string; icon: string }> = {
  order: { title: "Order records", icon: "order" }, picking: { title: "Picking records", icon: "list" },
  packing: { title: "Packing records", icon: "packing" }, shipping: {title:"Shipping records",icon:"shipping"},
  evidence:{title:"Photos and documents",icon:"photo"},handoff:{title:"Carrier handoffs",icon:"shipping"},
  delivery:{title:"Delivery confirmations",icon:"delivery"},returns:{title:"Returns",icon:"records"},
};
export function shortFolder(path:string){ return path.split(/[\\/]/).filter(Boolean).at(-1) || path; }
export function sourceName(s:WorkspaceSource){return s.displayName && s.displayName!==s.folder ? s.displayName : shortFolder(s.folder) || "Connected system";}
export function eligible(s:WorkspaceSource){return s.roles.length>0 && s.state!=="paused" && ["recognized","empty"].includes(s.recognition.state);}
export const kindNames:Record<string,[string,string]>={order:["order","Order received"],picking:["list","Picking recorded"],packing:["packing","Packing confirmed"],evidence:["photo","Evidence captured"],label:["shipping","Label created"],handoff:["shipping","Handed to carrier"],delivery:["delivery","Delivery recorded"],return:["records","Return recorded"],correction:["activity","Correction recorded"]};

export function Row({icon,title,detail,onClick,disabled}:{icon:string;title:string;detail?:string;onClick?:()=>void;disabled?:boolean}) {
  const contents=<><span className={"setup-tile tile-"+icon}><Icon name={icon} size={31}/></span><span className="setup-row-text"><strong>{title}</strong>{detail && <small>{detail}</small>}</span>{onClick && <span aria-hidden="true" className="setup-chevron">›</span>}</>;
  return onClick ? <button type="button" className="setup-row setup-click" onClick={onClick} disabled={disabled}>{contents}</button> : <div className="setup-row">{contents}</div>;
}
export function Context({label,title,intro,footer,children}:{label:string;title:ReactNode;intro?:string;footer?:string;children?:ReactNode}) {
  return <aside className="setup-context"><span className="setup-tag">{label}</span><h2>{title}</h2>{intro && <p className="setup-intro">{intro}</p>}<div className="setup-context-body">{children}</div>{footer && <p className="setup-context-footer">{footer}</p>}</aside>;
}
export function WelcomeExample() {
  return <aside className="setup-context setup-example" aria-label="Sample order preview"><div className="setup-split"><span className="setup-tag">Order preview</span><Icon name="layers" size={58}/></div>
    <h2>Order #10482</h2><p className="setup-subtle">North Ridge Supply · Sample order</p><span className="setup-tag setup-transit">In transit · 3 of 4 stages</span>
    <div className="setup-timeline"><Row icon="order" title="Order placed" detail="Customer order, 3 items"/><Row icon="packing" title="Packed and checked" detail="Packing list and 2 photos"/>
      <Row icon="shipping" title="Handed to carrier" detail="Tracking and shipment record"/><Row icon="pendingDelivery" title="Awaiting delivery" detail="Waiting for the carrier’s confirmation"/></div>
    <p className="setup-context-footer">Next update: delivery confirmation</p></aside>;
}
export function Progress({n,label}:{n:number;label:string}){return <div className="setup-progress" aria-label={`Step ${n} of 4: ${label}`}><span>{n} of 4 &nbsp;/&nbsp; {label}</span><div aria-hidden="true">{[1,2,3,4].map(i=><i key={i} className={i<=n?"filled":""}/>)}</div></div>;}
export function SetupDialog({title,children,onClose}:{title:string;children:ReactNode;onClose:()=>void}){
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const d=ref.current;if(!d)return;const opener=document.activeElement;
    if(typeof d.showModal==="function")d.showModal();else d.setAttribute("open","");
    return()=>{if(d.open && typeof d.close==="function")d.close();if(opener instanceof HTMLElement && opener.isConnected)opener.focus();};
  },[]);
  return <dialog ref={ref} className="setup-dialog" aria-label={title} onCancel={e=>{e.preventDefault();onClose();}}>
    <div className="setup-split"><h2>{title}</h2><button type="button" className="setup-link" onClick={onClose}>Close</button></div>{children}</dialog>;
}
