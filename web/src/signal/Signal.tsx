import { useEffect, useRef, useState, type ReactNode } from 'react';
export const SIGNAL_ENABLED = import.meta.env.VITE_PACKPROOF_SIGNAL !== 'false';

export function SignalSteps({ step }: { step: 1 | 2 | 3 }) {
  return <ol className="signal-steps" aria-label="Packing progress">{['Record', 'Review', 'Save'].map((label, i) => <li key={label} className={i + 1 < step ? 'is-done' : i + 1 === step ? 'is-current' : ''} aria-current={i + 1 === step ? 'step' : undefined}><span><b aria-hidden="true">{i + 1 < step ? '✓' : i + 1}</b> {label}</span></li>)}</ol>;
}
export function SignalParcel({ sealed = false }: { sealed?: boolean }) {
  return <div className={`signal-parcel${sealed ? ' is-sealed' : ''}`} aria-hidden="true"><img src={`/signal/${sealed ? 'sealed' : 'parcel'}.svg`} alt="" /></div>;
}
export function SignalBadge({ state, children }: { state: 'local' | 'uploading' | 'saved' | 'attention'; children: ReactNode }) {
  return <span className={`signal-badge signal-badge-${state}`}><span aria-hidden="true">{state === 'saved' ? '✓' : state === 'attention' ? '!' : state === 'uploading' ? '↑' : '·'}</span>{children}</span>;
}
export function SignalSheet({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) { trigger.current = document.activeElement as HTMLElement; if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [open]);
  return <dialog ref={dialog} className="signal-sheet" aria-label={title} onCancel={onClose} onClose={() => { onClose(); trigger.current?.focus(); }}><div className="signal-sheet-handle" aria-hidden="true" /><h2>{title}</h2>{children}</dialog>;
}
export function SignalGuide({ onStart, disabled, busy, audio = false }: { onStart: () => void; disabled?: boolean; busy?: boolean; audio?: boolean }) {
  return <section className="signal-guide"><div className="eim-task-heading"><p className="signal-mono">CONTINUOUS PACKING CAPTURE</p><h1>From item<br />to sealed box.</h1><p>Keep the packing process in one continuous recording.</p></div><SignalParcel /><ol className="eim-capture-guide">{[['Show the item', 'Make its condition easy to see.'], ['Pack it on camera', 'Keep the item and box in view.'], ['Finish with the seal', 'Show the closed parcel before stopping.']].map(([title, body], index) => <li key={title}><span aria-hidden="true">0{index + 1}</span><div><strong>{title}</strong><p>{body}</p></div></li>)}</ol><button className="btn" disabled={disabled} onClick={onStart}>{busy ? 'Preparing camera.' : 'Start recording'} <span aria-hidden="true">→</span></button><p className="signal-caption">{audio ? 'Microphone audio is enabled.' : 'Camera recording has no sound.'}</p></section>;
}
export function SignalProgress({ percent, confirming, paused = false, originalAvailable, children }: { percent: number | null; confirming: boolean; paused?: boolean; originalAvailable?: boolean; children?: ReactNode }) {
  const bounded = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
  const stage = paused ? 'UPLOAD PAUSED' : confirming ? 'CONFIRMING' : 'UPLOADING';
  return <section className="signal-progress"><header className="eim-task-heading"><p className="signal-mono" role="status">{stage}</p><h1>{paused ? 'Your upload is paused.' : confirming ? 'Confirming your Proof.' : 'Saving your Proof.'}</h1><p>{paused ? 'Review the upload notice below. The current operation keeps its place.' : confirming ? "Your recording reached the server. We're checking the saved record." : 'Your packing record is on its way.'}</p></header><div className="signal-progress-value" aria-hidden="true"><strong>{confirming || bounded === null ? '—' : `${bounded}%`}</strong><div><span className="signal-mono">{stage}</span><p>Packing recording</p></div></div><progress aria-label={confirming ? 'Waiting for server confirmation' : 'Recording upload'} value={!confirming && bounded !== null ? bounded : undefined} max={100} /><ol className="signal-progress-events"><li>{originalAvailable===true?'Recording on this device':originalAvailable===false?'Local recording unavailable':'Check local recording availability'}<span>{originalAvailable===true?'Retained while this operation is pending':originalAvailable===false?'Open the recovery details before continuing.':'The operation keeps its identity while availability is checked.'}</span></li><li>{confirming ? 'Recording transferred' : 'Uploading recording'}<span>{!confirming && bounded !== null ? `${bounded}% complete` : originalAvailable===true?'The original remains on this device.':originalAvailable===false?'The local original is unavailable.':'Review the recovery details for local availability.'}</span></li><li>Waiting for confirmation<span>We'll confirm when the record is saved.</span></li></ol><p className="signal-note">{originalAvailable===true?"Keep this local recording until saving is confirmed.":originalAvailable===false?"PackProof cannot promise local recovery for this recording. Review any server-confirmed evidence before retrying.":"Keep available originals until saving is confirmed. Local availability is shown by the current recovery operation."}</p>{children}</section>;
}
const revealedReceipts = new Set<string>();
export function SignalReceipt({ title, proofId, savedAt, duration, onView, onHome }: { title: string; proofId: string; savedAt: string; duration?: string; onView: () => void; onHome: () => void }) {
  // Presentation-only memory. Actual completion is authorized by the caller's canonical receipt predicate.
  const key = `${proofId}:${savedAt}`;
  const [reveal] = useState(() => !revealedReceipts.has(key));
  useEffect(() => { revealedReceipts.add(key); if (revealedReceipts.size > 512) revealedReceipts.delete(revealedReceipts.values().next().value!); }, [key]);
  return <section className={`signal-receipt-wrap${reveal ? ' eim-receipt-reveal' : ''}`}><div className="signal-receipt"><header><span className="signal-mono"><span aria-hidden="true">✓</span> SAVED TO PACKPROOF</span><h1>Proof saved.</h1><p>Your packing evidence is together in one record.</p></header><div className="eim-receipt-body"><h2>{title}</h2><p className="signal-mono">{proofId}</p><dl><div><dt>Recording</dt><dd>{duration ? `${duration} · ` : ''}Original</dd></div><div><dt>Saved</dt><dd><time dateTime={savedAt}>{new Date(savedAt).toLocaleString()}</time></dd></div></dl><p className="eim-receipt-limitation">This confirms the submitted record was saved. It does not independently verify the physical parcel.</p></div></div><button className="btn" onClick={onView}>View your Proof <span aria-hidden="true">→</span></button><button className="btn btn-tertiary" onClick={onHome}>Back to Home</button></section>;
}
