import { useEffect, useRef, type ReactNode } from 'react';
export const SIGNAL_ENABLED = import.meta.env.VITE_PACKPROOF_SIGNAL !== 'false';
export function SignalSteps({step}: {step: 1|2|3}) {
  return <ol className="signal-steps" aria-label="Packing progress">{['Record','Review','Save'].map((label,i)=><li key={label} className={i+1<step?'is-done':i+1===step?'is-current':''} aria-current={i+1===step?'step':undefined}><span>{i+1<step?'✓':i+1} {label}</span></li>)}</ol>;
}
export function SignalParcel({sealed=false}: {sealed?:boolean}) {
  return <div className={`signal-parcel${sealed?' is-sealed':''}`} aria-hidden="true"><img src={`/signal/${sealed?'sealed':'parcel'}.svg`} alt="" /></div>;
}
export function SignalBadge({state,children}: {state:'local'|'uploading'|'saved'|'attention';children:ReactNode}) {
  return <span className={`signal-badge signal-badge-${state}`}><span aria-hidden="true">●</span>{children}</span>;
}
export function SignalSheet({open,title,children,onClose}: {open:boolean;title:string;children:ReactNode;onClose:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null), trigger=useRef<HTMLElement|null>(null);
  useEffect(()=>{if(open){trigger.current=document.activeElement as HTMLElement;dialog.current?.showModal();}else dialog.current?.close();},[open]);
  return <dialog ref={dialog} className="signal-sheet" aria-label={title} onCancel={onClose} onClose={()=>{onClose();trigger.current?.focus();}}><div className="signal-sheet-handle"/><h2>{title}</h2>{children}</dialog>;
}
export function SignalGuide({onStart,disabled,busy,audio=false}: {onStart:()=>void;disabled?:boolean;busy?:boolean;audio?:boolean}) {
  return <section className="signal-guide"><h1>From item<br/>to sealed box.</h1><p>Keep the packing process in one continuous recording.</p><SignalParcel/><ul>{[['Show the item','Make its condition easy to see.'],['Pack it on camera','Keep the item and box in view.'],['Finish with the seal','Show the closed parcel before stopping.']].map(([title,body])=><li key={title}><div><strong>{title}</strong><p>{body}</p></div></li>)}</ul><button className="btn" disabled={disabled} onClick={onStart}>{busy?'Preparing camera…':'Start recording'} <span aria-hidden="true">→</span></button><p className="signal-caption">{audio?"Microphone audio is enabled.":"Camera recording has no sound."}</p></section>;
}
export function SignalProgress({percent,confirming,paused=false,children}: {percent:number|null;confirming:boolean;paused?:boolean;children?:ReactNode}) {
  const bounded=percent===null?null:Math.max(0,Math.min(100,Math.round(percent)));
  return <section className="signal-progress" aria-live="polite"><h1>{paused?'Your take is safe.':confirming?'Confirming your Proof.':'Saving your Proof.'}</h1><p>{paused?'Uploading is paused. Your recording stays on this device.':confirming?'Your recording reached the server. We’re checking the saved record.':'Your packing record is on its way.'}</p><div className="signal-progress-value"><strong>{confirming?'…':bounded===null?'…':`${bounded}%`}</strong><div><span className="signal-mono">{paused?'UPLOAD PAUSED':confirming?'CONFIRMING':'UPLOADING'}</span><p>Packing recording</p></div></div><progress aria-label={confirming?'Waiting for server confirmation':'Recording upload'} value={!confirming&&bounded!==null?bounded:undefined} max={100}/><ol className="signal-progress-events"><li>Recording on this device<span>Ready for upload</span></li><li>{confirming?'Recording transferred':'Uploading recording'}<span>{!confirming&&bounded!==null?`${bounded}% complete`:'The original remains on this device.'}</span></li><li>Waiting for confirmation<span>We’ll confirm when the record is saved.</span></li></ol><p className="signal-note">Your recording stays on this device until saving is confirmed.</p>{children}</section>;
}
export function SignalReceipt({title,proofId,savedAt,duration,onView,onHome}: {title:string;proofId:string;savedAt:string;duration?:string;onView:()=>void;onHome:()=>void}) {
  return <section className="signal-receipt-wrap"><div className="signal-receipt"><span className="signal-mono">✓ &nbsp; SAVED TO PACKPROOF</span><h1>Proof<br/>saved.</h1><SignalParcel sealed/><hr/><h2>{title}</h2><p className="signal-mono">{proofId}</p><dl><div><dt>Recording</dt><dd>{duration?`${duration} · `:''}Original</dd></div><div><dt>Saved</dt><dd>{new Date(savedAt).toLocaleString()}</dd></div></dl></div><p>Your recording and packing confirmation are together in this Proof.</p><button className="btn" onClick={onView}>View your Proof <span aria-hidden="true">→</span></button><button className="btn btn-tertiary" onClick={onHome}>Back to Home</button></section>;
}
