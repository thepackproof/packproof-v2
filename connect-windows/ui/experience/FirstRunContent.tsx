import type { ReactNode } from "react";
import "./FirstRunContent.css";

export interface FirstRunContentProps {
  heading?: string;
  intro?: ReactNode;
  title?: string;
  description?: ReactNode;
  primaryLabel: string;
  onPrimary: () => void;
  disabled?: boolean;
  busy?: boolean;
  secondaryAction?: ReactNode;
  children?: ReactNode;
  showSteps?: boolean;
  primaryClassName?: string;
}

/** Shared first-run content from approved Evidence OS frame 3:15.
 * The caller supplies real status and authorized operations; this never scans,
 * grants access or reports collection success by itself.
 */
export function FirstRunContent({
  heading = "Your facility. Connected.",
  intro = "PackProof looks for the records your teams already create. No new warehouse software required.",
  title = "Start with your existing systems.",
  description = "Discover likely sources. Review permissions. Then let PackProof do the work.",
  primaryLabel, onPrimary, disabled, busy, secondaryAction, children,
  showSteps = true, primaryClassName = "",
}: FirstRunContentProps) {
  return <section className="pp-first-run" data-design-file="nNnkgTZOBNkG8muy8AkIv1" data-design-node="3:15">
    <header className="pp-first-run-heading">
      <h1>{heading}</h1>
      <p>{intro}</p>
    </header>
    <section className="pp-first-run-hero" aria-label="Connect your existing systems">
      <div className="pp-first-run-copy">
        <h2>{title}</h2>
        <p>{description}</p>
        <div className="pp-first-run-actions">
          <button type="button" className={`pp-first-run-primary ${primaryClassName}`.trim()}
            onClick={onPrimary} disabled={disabled || busy} aria-busy={busy || undefined}>
            {primaryLabel}
          </button>
          {secondaryAction}
          <span className="pp-first-run-readonly">Read only</span>
        </div>
      </div>
      <div className="pp-first-run-systems" aria-hidden="true">
        <img className="pp-first-run-data" src="./brand/connect/evidence-os/data.svg" width={65} height={65} alt="" />
        <img className="pp-first-run-link" src="./brand/connect/evidence-os/link.svg" width={32} height={32} alt="" />
        <img className="pp-first-run-box" src="./brand/connect/evidence-os/box.svg" width={35} height={35} alt="" />
      </div>
    </section>
    {children && <div className="pp-first-run-state">{children}</div>}
    {showSteps && <section className="pp-first-run-steps" aria-labelledby="pp-first-run-steps-title">
      <h2 id="pp-first-run-steps-title">Three simple steps</h2>
      <ol>
        <li><div><span>01</span><img src="./brand/connect/evidence-os/search.svg" width={27} height={27} alt="" /></div>
          <h3>Find what is already there</h3><p>Recognize local exports and supported system integrations.</p></li>
        <li><div><span>02</span><img src="./brand/connect/evidence-os/shield.svg" width={27} height={27} alt="" /></div>
          <h3>Confirm the connections</h3><p>Approve what PackProof can read and inspect a sample.</p></li>
        <li><div><span>03</span><img src="./brand/connect/evidence-os/activity.svg" width={27} height={27} alt="" /></div>
          <h3>Switch on automation</h3><p>Orders, events and proofs flow without manual work.</p></li>
      </ol>
    </section>}
    <footer className="pp-first-run-footer"><span>Secure by design</span><p>Explicit source permissions. Original evidence is never silently modified.</p></footer>
  </section>;
}
