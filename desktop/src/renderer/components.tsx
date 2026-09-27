import { useEffect, useRef, type ReactNode } from 'react';

const paths: Record<string,string> = {
  home:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  proofs:'M5 3h14v18H5ZM8 8h8M8 12h8M8 16h5',
  station:'M3 6h13v12H3ZM16 10l5-3v10l-5-3',
  orders:'m3 7 9-4 9 4v11l-9 4-9-4ZM3 7l9 4 9-4M12 11v11M7 5l10 4',
  integrations:'M8 3v4M16 3v4M5 7h14v3a7 7 0 0 1-14 0ZM12 17v5',
  uploads:'M12 16V3M7 8l5-5 5 5M4 15v6h16v-6',
  notifications:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  search:'M16 16l5 5M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14',
  plus:'M12 5v14M5 12h14', check:'m5 12 4 4L19 6', arrow:'M4 12h16M14 6l6 6-6 6',
  refresh:'M20 9a8 8 0 0 0-14-5L3 7M3 3v4h4M4 15a8 8 0 0 0 14 5l3-3M17 17h4v4',
  close:'m6 6 12 12M18 6 6 18', shield:'m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z',
  warning:'m12 3 10 18H2ZM12 9v5M12 17v1', link:'m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  logout:'M9 3H3v18h6M8 12h13M16 7l5 5-5 5', play:'m8 4 12 8-12 8Z',
};
export function Icon({name, size=20}: {name:string;size?:number}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.proofs}/></svg>;
}
export function Brand() { return <div className="brand"><span className="brand-mark"><Icon name="shield" size={25}/><span/></span><span>PackProof<span className="brand-sub">DESKTOP WORKSTATION</span></span></div>; }
export function Empty({icon='proofs', title, children, action}: {icon?:string;title:string;children?:ReactNode;action?:ReactNode}) {
  return <div className="empty"><span className="empty-icon"><Icon name={icon} size={27}/></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
export function Badge({children, tone='neutral'}: {children:ReactNode;tone?:'neutral'|'green'|'blue'|'amber'|'red'}) { return <span className={`badge ${tone}`}>{children}</span>; }
export function ErrorNotice({children}: {children:ReactNode}) { return <div className="notice error" role="alert"><Icon name="warning"/><span>{children}</span></div>; }
export function Modal({title, children, close}: {title:string;children:ReactNode;close:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{ref.current?.showModal(); const dialog=ref.current; return()=>dialog?.close();},[]);
  return <dialog ref={ref} className="modal" onCancel={event=>{event.preventDefault();close();}}><div className="modal-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><Icon name="close"/></button></div>{children}</dialog>;
}
export function SectionHeading({title, children}: {title:string;children?:ReactNode}) { return <div className="section-heading"><h2>{title}</h2>{children}</div>; }
