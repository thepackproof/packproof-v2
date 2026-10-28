import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './dashboard-tour.css';

const TOUR_VERSION = 1;
type TourProgress = { version: number; status: 'started' | 'completed' | 'dismissed'; step: number };
export type DashboardTourStep = { target: string; title: string; body: string };
export const DASHBOARD_TOUR_STEPS: readonly DashboardTourStep[] = [
  { target: 'overview', title: 'Your shipment workspace', body: 'Use the overview to see the records in this view and spot work that needs attention. A loaded-record count describes this view, not your entire account.' },
  { target: 'search', title: 'Find the right shipment', body: 'Search by item, order reference, tracking number or Proof ID. Submit the search to load matching records from PackProof.' },
  { target: 'filters', title: 'Narrow down your work', body: 'Use status, creation dates and the connected store to narrow the list. Creation-date filters use UTC; record times use your local timezone. Clear filters to return to the full view.' },
  { target: 'records', title: 'Know what to do next', body: 'Each record shows its status and next step. Ready means the Proof is finalized and its required preservation receipts are confirmed. Open a record to review its evidence, activity, sharing and export options.' },
  { target: 'connections', title: 'Keep imports moving', body: 'Check your connected stores and follow any recommended connection action. Order-import coverage and finalized counts are separate from a Proof’s preservation readiness.' },
  { target: 'create', title: 'Record a shipment', body: 'Choose New Proof when you are ready to start. Record the packing, review it and confirm it yourself. This tour does not create a Proof or change any shipment. You can replay it here whenever you need a reminder.' },
];

const memoryProgress = new Map<string, TourProgress>();
const storageKey = (accountKey: string) => `packproof:dashboard-tour:v${TOUR_VERSION}:${encodeURIComponent(accountKey)}`;
function parseProgress(value: string | null, stepCount: number): TourProgress | null {
  try {
    const parsed: unknown = JSON.parse(value ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Partial<TourProgress>;
    if (record.version !== TOUR_VERSION || !['started', 'completed', 'dismissed'].includes(record.status ?? '') ||
      typeof record.step !== 'number' || !Number.isInteger(record.step) || record.step < 0 || record.step >= stepCount) return null;
    return record as TourProgress;
  } catch { return null; }
}
function remember(key: string, progress: TourProgress) {
  memoryProgress.delete(key);
  memoryProgress.set(key, progress);
  if (memoryProgress.size > 50) memoryProgress.delete(memoryProgress.keys().next().value!);
  try { localStorage.setItem(key, JSON.stringify(progress)); } catch { /* The tour still works for this browser session. */ }
}
function readProgress(key: string, stepCount: number) {
  try {
    const saved = localStorage.getItem(key);
    return saved === null ? memoryProgress.get(key) ?? null : parseProgress(saved, stepCount);
  } catch { return memoryProgress.get(key) ?? null; }
}
function otherDialogIsOpen() {
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"], dialog[open]')]
    .some(element => !element.closest('[data-dashboard-tour-layer], [hidden], [aria-hidden="true"]'));
}

export const replayDashboardTour = () => window.dispatchEvent(new Event('packproof:replay-dashboard-tour'));

export function DashboardTour(props: { accountKey: string; ready?: boolean; steps?: readonly DashboardTourStep[] }) {
  return <AccountDashboardTour key={props.accountKey} {...props} />;
}

function AccountDashboardTour({ accountKey, ready = true, steps = DASHBOARD_TOUR_STEPS }: {
  accountKey: string; ready?: boolean; steps?: readonly DashboardTourStep[];
}) {
  const key = storageKey(accountKey);
  const [progress, setProgress] = useState(() => readProgress(key, steps.length));
  const replayButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [blocked, setBlocked] = useState(otherDialogIsOpen);
  const step = Math.min(progress?.step ?? 0, Math.max(0, steps.length - 1));
  const allowed = ready && Boolean(accountKey) && steps.length > 0;
  const save = (status: TourProgress['status'], nextStep = step) => {
    const next: TourProgress = { version: TOUR_VERSION, status, step: nextStep };
    remember(key, next);
    setProgress(next);
  };
  const start = (resume = false) => {
    if (!allowed || otherDialogIsOpen()) return;
    save('started', resume && progress?.status === 'started' ? step : 0);
    setOpen(true);
  };
  useEffect(() => {
    const update = () => setBlocked(otherDialogIsOpen());
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal', 'aria-hidden', 'hidden', 'open'] });
    update();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (blocked || !allowed) setOpen(false); }, [blocked, allowed]);
  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (event.key !== key && event.key !== null) return;
      memoryProgress.delete(key);
      const next = parseProgress(event.key === null ? null : event.newValue, steps.length);
      if (next) memoryProgress.set(key, next);
      setProgress(next);
      if (next?.status !== 'started') setOpen(false);
    };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, [key, steps.length]);
  useEffect(() => {
    const replay = () => {
      if (!allowed || otherDialogIsOpen()) return;
      const next: TourProgress = { version: TOUR_VERSION, status: 'started', step: 0 };
      remember(key, next); setProgress(next); setOpen(true);
    };
    window.addEventListener('packproof:replay-dashboard-tour', replay);
    return () => window.removeEventListener('packproof:replay-dashboard-tour', replay);
  }, [allowed, key]);
  const dismiss = () => { save('dismissed'); setOpen(false); };
  const invite = allowed && !blocked && !open && (!progress || progress.status === 'started');
  return <div className="dashboard-tour-entry">
    <button ref={replayButton} type="button" className="btn btn-secondary" disabled={!allowed || blocked} onClick={() => start(progress?.status === 'started')}>Take dashboard tour</button>
    {invite && <aside className="dashboard-tour-invitation" aria-label="Dashboard introduction">
      <div><strong>{progress?.status === 'started' ? 'Pick up where you left off' : 'New to this dashboard?'}</strong><p>{progress?.status === 'started' ? 'Continue the short tour to learn the rest of your workspace.' : 'Take a short guided tour to learn how to find shipments, understand their status and keep work moving.'}</p></div>
      <div className="dashboard-tour-invitation-actions"><button type="button" className="btn" onClick={() => start(true)}>{progress?.status === 'started' ? 'Resume tour' : 'Start dashboard tour'}</button><button type="button" className="text-link" onClick={dismiss}>Maybe later</button></div>
    </aside>}
    {open && allowed && !blocked && <TourOverlay step={step} steps={steps} onBack={() => save('started', step - 1)} onNext={() => {
      if (step === steps.length - 1) { save('completed'); setOpen(false); }
      else save('started', step + 1);
    }} onSkip={dismiss} onRestoreFocus={() => replayButton.current?.focus()} />}
  </div>;
}

function TourOverlay({ step, steps, onBack, onNext, onSkip, onRestoreFocus }: {
  step: number; steps: readonly DashboardTourStep[]; onBack: () => void; onNext: () => void; onSkip: () => void; onRestoreFocus: () => void;
}) {
  const layer = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null);
  const actions = useRef({ onSkip, onRestoreFocus }); actions.current = { onSkip, onRestoreFocus };
  const id = useId();
  const [position, setPosition] = useState({ left: 16, top: 80, x: 0, y: 0, width: 0, height: 0, found: false });
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const siblings = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== layer.current);
    const oldInert = siblings.map(element => element.inert);
    siblings.forEach(element => { element.inert = true; });
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); actions.current.onSkip(); }
      if (event.key !== 'Tab') return;
      const buttons = [...card.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []];
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === card.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === card.current)) { event.preventDefault(); first.focus(); }
    };
    const focusin = (event: FocusEvent) => {
      if (card.current && !card.current.contains(event.target as Node) && !otherDialogIsOpen()) card.current.focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin, true);
    card.current?.focus();
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin, true);
      siblings.forEach((element, index) => { element.inert = oldInert[index]; });
      if (!otherDialogIsOpen()) {
        if (previous?.isConnected && previous !== document.body && previous !== document.documentElement) previous.focus();
        else actions.current.onRestoreFocus();
      }
    };
  }, []);
  useEffect(() => {
    const target = [...document.querySelectorAll<HTMLElement>('[data-dashboard-tour]')].find(element => element.dataset.dashboardTour === steps[step].target);
    target?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
    const measure = () => {
      const rect = target?.getBoundingClientRect();
      const found = Boolean(rect && rect.width > 0 && rect.height > 0);
      const cardWidth = Math.min(380, window.innerWidth - 32), cardHeight = card.current?.offsetHeight || 300;
      const x = rect ? Math.max(8, rect.left - 6) : 0, y = rect ? Math.max(8, rect.top - 6) : 0;
      const width = rect ? Math.max(0, Math.min(rect.width + 12, window.innerWidth - x - 8)) : 0;
      const height = rect ? Math.max(0, Math.min(rect.height + 12, window.innerHeight - y - 8)) : 0;
      const top = found ? y + height + cardHeight + 24 < window.innerHeight ? y + height + 16 : y - cardHeight - 16 : (window.innerHeight - cardHeight) / 2;
      setPosition({ left: Math.max(16, Math.min(found ? x : (window.innerWidth - cardWidth) / 2, window.innerWidth - cardWidth - 16)), top: Math.max(16, Math.min(top, window.innerHeight - cardHeight - 16)), x, y, width, height, found });
    };
    measure();
    card.current?.focus();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (target) observer?.observe(target);
    if (card.current) observer?.observe(card.current);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [step, steps]);
  return createPortal(<div className="dashboard-tour-layer" data-dashboard-tour-layer="true" ref={layer}>
    <div className={position.found ? 'dashboard-tour-spotlight' : 'dashboard-tour-backdrop'} aria-hidden="true" style={position.found ? { left: position.x, top: position.y, width: position.width, height: position.height } : undefined} />
    <div ref={card} className="dashboard-tour-card" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} tabIndex={-1} style={{ left: position.left, top: position.top }}>
      <p className="dashboard-tour-meta">Dashboard tour · Step {step + 1} of {steps.length}</p>
      <progress max={steps.length} value={step + 1} aria-label="Tour progress" />
      <h2 id={`${id}-title`}>{steps[step].title}</h2><p id={`${id}-body`}>{steps[step].body}</p>
      {!position.found && <p className="dashboard-tour-context">This part of the workspace may be empty or unavailable in your current view. You can continue the tour.</p>}
      <div className="dashboard-tour-actions"><button type="button" className="text-link" onClick={onSkip}>Skip tour</button><span /><button type="button" className="btn btn-secondary" disabled={step === 0} onClick={onBack}>Back</button><button type="button" className="btn" onClick={onNext}>{step === steps.length - 1 ? 'Finish tour' : 'Next'}</button></div>
    </div>
  </div>, document.body);
}
