import { useCallback, useEffect, useRef, useState } from 'react';
import type { SurfaceComparison, SurfaceRecord, SurfaceScope, SurfaceSource, SurfaceSummary, SurfaceTransport } from '../api/surface-types';
import './surface-fingerprint.css';

const scopes: Array<[SurfaceScope, string]> = [['label', 'Label surface'], ['carton', 'Carton surface'], ['assembly', 'Label + carton relationship']];
const human = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');
const time = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
const message = (error: unknown) => error instanceof Error ? error.message : 'The research record could not be loaded. Try again.';

/** R&D never presents positive/negative physical findings, even from an unexpected server profile. */
export function researchStatus(status: string | undefined): string {
  return ({ requested: 'Queued', processing: 'Processing', inconclusive: 'Unable to compare', unsupported: 'Unsupported configuration', not_checked: 'Not checked', error: 'Analysis unavailable — retry required' } as Record<string, string>)[status || ''] || 'Unable to compare — profile unqualified';
}
function safeRows(value: unknown, prefix = '', depth = 0): Array<[string, string]> {
  if (value === null || value === undefined) return [[prefix || 'Coverage', 'Not recorded']];
  if (depth > 4) return [[prefix, 'Additional details in export']];
  if (typeof value !== 'object') return [[human(prefix), String(value)]];
  return Object.entries(value).flatMap(([key, item]) => safeRows(item, prefix ? `${prefix} / ${key}` : key, depth + 1));
}
function Metadata({ value, empty }: { value: unknown; empty: string }) {
  const rows = value ? safeRows(value) : [];
  return rows.length ? <dl className="surface-metadata">{rows.map(([key, item], index) => <div key={`${key}.${index}`}><dt>{key}</dt><dd>{item}</dd></div>)}</dl> : <p>{empty}</p>;
}

function OriginalPreview({ url, source, record, save, busy }: { url: string; source: SurfaceSource; record: SurfaceRecord; save: () => void; busy: boolean }) {
  const [size, setSize] = useState<{width: number; height: number} | null>(null);
  const [overlay, setOverlay] = useState(true);
  const regions = record.regionMap.filter(region => region.sourceId === source.sourceId);
  return <>
    {source.contentType.startsWith('image/') ? <><label className="surface-overlay-toggle"><input type="checkbox" checked={overlay} onChange={event => setOverlay(event.target.checked)} />Show recorded region boundaries</label><div className="surface-image-stage"><img src={url} onLoad={event => setSize({width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight})} alt={`Original source ${source.sourceId}; consult the recorded pixel regions below`} />{overlay && size && <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-label="Recorded region overlay">{regions.map((region, index) => region.polygon?.length ? <g key={region.id || region.regionId || index}><polygon points={region.polygon.map(point => point.join(',')).join(' ')} stroke={region.group === 'carton' ? '#55baff' : region.group === 'context' ? '#fff' : '#ffc857'} strokeWidth={2} vectorEffect="non-scaling-stroke" fill="transparent" /><text x={region.polygon[0][0]} y={region.polygon[0][1]} dy="1em" fill="#fff" stroke="#182130" strokeWidth={Math.max(1, size.width / 1400)} paintOrder="stroke" fontSize={Math.max(14, size.width / 55)}>{`${index + 1}. ${region.group || 'region'}`}</text></g> : null)}</svg>}</div></> : <p>This source format cannot be previewed here. Download the original to inspect it.</p>}
    <p className="surface-muted">Original source {source.sourceId}. Colored boundaries are a review overlay, not part of the original. Region coordinates refer to original pixels; previews may be scaled.</p><Metadata value={regions} empty="No regions reference this source." /><button type="button" disabled={busy} onClick={save}>Save selected original</button>
  </>;
}

function Comparison({ comparison }: { comparison: SurfaceComparison }) {
  const result = comparison.result;
  return <article className="surface-comparison">
    <div className="surface-row"><h4>{researchStatus(comparison.status)}</h4><span className="surface-tag">Research only</span></div>
    <p className="surface-muted">Requested scope: {scopes.find(([scope]) => scope === comparison.requestedScope)?.[1] || comparison.requestedScope} · {time(comparison.createdAt)}</p>
    <div className="surface-scopes">{scopes.map(([scope, label]) => {
      const finding = result?.scopeResults?.[scope];
      return <section key={scope}><h5>{label}</h5><strong>{researchStatus(finding?.status || (result ? 'inconclusive' : 'not_checked'))}</strong>{finding?.reasons?.length ? <ul>{finding.reasons.map((reason, index) => <li key={index}>{human(reason)}</li>)}</ul> : <p>No qualified finding is available.</p>}</section>;
    })}</div>
    <p className="surface-warning">No optical profile is qualified in this R&amp;D build. Similarity measurements do not establish physical identity.</p>
    {result?.limitations?.length ? <ul>{result.limitations.map((limit, index) => <li key={index}>{human(limit)}</li>)}</ul> : null}
    <details><summary>Coverage and missing regions</summary><Metadata value={result?.coverage} empty="Coverage has not been measured. Missing regions cannot support a combined finding." /></details>
    <details><summary>Method and source commitments</summary><dl className="surface-metadata"><div><dt>Analysis ID</dt><dd>{comparison.id}</dd></div><div><dt>Enrollment</dt><dd>{comparison.enrollmentId}</dd></div><div><dt>Later observation</dt><dd>{comparison.observationId}</dd></div></dl><Metadata value={result?.method} empty="Method versions will appear after processing." /><Metadata value={result?.sourceDigests} empty="Source commitments will appear after processing." /></details>
  </article>;
}

function Observation({ record, onSource, busy }: { record: SurfaceRecord; onSource: (source: SurfaceSource, record: SurfaceRecord) => void; busy: boolean }) {
  return <details className="surface-observation"><summary>{record.enrollmentId ? 'Later observation' : 'Enrollment'} · {time(record.createdAt)} · {human(record.state)}</summary>
    <dl className="surface-metadata">
      <div><dt>Record ID</dt><dd>{record.id}</dd></div><div><dt>Package / shipment leg</dt><dd>{record.packageInstanceId} / {record.shipmentLegId}</dd></div>
      <div><dt>Capture profile</dt><dd>{record.captureProfileId}</dd></div><div><dt>Capture mode</dt><dd>{human(record.captureMode)}</dd></div><div><dt>Opening context (reported)</dt><dd>{human(record.contextStage)}</dd></div>
      <div><dt>Acquisition assurance</dt><dd>{human(record.assurance)} — not sensor certification</dd></div><div><dt>Received by server</dt><dd>{time(record.createdAt)}</dd></div><div><dt>Record SHA-256</dt><dd>{record.sha256}</dd></div>
    </dl>
    <p className="surface-muted">Server receipt time does not establish when the scene occurred. A digest protects bytes; it does not identify a physical surface.</p>
    {record.sourceDigests.map(source => <div className="surface-source" key={source.sourceId}><div><strong>Selected original · {source.sourceId}</strong><p>{source.contentType} · {Number(source.byteSize).toLocaleString()} bytes · {source.frameTimeMs === null ? 'Frame time unavailable' : `${source.frameTimeMs} ms from capture start`}</p><code>{source.sha256}</code></div><button type="button" disabled={busy || source.available === false} onClick={() => onSource(source, record)}>{source.available === false ? 'Original unavailable' : 'Review original'}</button></div>)}
    {!record.sourceDigests.length && <p>No committed originals are available.</p>}
    <details><summary>Region map ({record.regionMap.length})</summary><Metadata value={record.regionMap} empty="No selected regions." /></details>
    <details><summary>Frozen capture method and required groups</summary><Metadata value={record.method} empty="Method versions not recorded." /><Metadata value={record.requiredGroups} empty="Required coverage groups not recorded." /></details>
  </details>;
}

/** Hidden and network-silent until the build flag and reviewer opt-in are both enabled. */
export function SurfaceFingerprintPanel({ proofId, enabled, transport, platform = 'browser' }: { proofId: string; enabled: boolean; transport: SurfaceTransport; platform?: 'browser' | 'desktop' }) {
  const [optedIn, setOptedIn] = useState(false);
  const [summary, setSummary] = useState<SurfaceSummary | null>(null);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const [enrollmentId, setEnrollmentId] = useState(''); const [observationId, setObservationId] = useState(''); const [scope, setScope] = useState<SurfaceScope>('assembly');
  const [preview, setPreview] = useState<{ url: string; source: SurfaceSource; record: SurfaceRecord; release?: () => void } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const retryKeys = useRef(new Map<string, string>()); const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const current = epoch.current;
    try { const result = await transport.read(proofId); if (current === epoch.current) { setSummary(result); setError(''); } }
    catch (reason) { if (current === epoch.current) setError(message(reason)); }
  }, [proofId, transport]);
  useEffect(() => { epoch.current++; setOptedIn(false); setSummary(null); setError(''); setNotice(''); setBusy(false); setEnrollmentId(''); setObservationId(''); setPreview(null); retryKeys.current.clear(); return () => { epoch.current++; }; }, [proofId, enabled, transport]);
  useEffect(() => { if (enabled && optedIn) void refresh(); }, [enabled, optedIn, refresh]);
  const pending = summary?.comparisons.some(row => row.status === 'requested' || row.status === 'processing');
  useEffect(() => { if (!enabled || !optedIn || !pending) return; const timer = window.setInterval(() => { void refresh(); }, 5000); return () => window.clearInterval(timer); }, [enabled, optedIn, pending, refresh]);
  useEffect(() => { if (preview) { previewRef.current?.focus({preventScroll: true}); previewRef.current?.scrollIntoView({block: 'start', behavior: 'smooth'}); } return () => preview?.release?.(); }, [preview]);
  if (!enabled) return null;
  const enrollment = summary?.enrollments.find(row => row.id === enrollmentId);
  const observations = summary?.observations.filter(row => row.enrollmentId === enrollmentId && row.packageInstanceId === enrollment?.packageInstanceId && row.shipmentLegId === enrollment?.shipmentLegId) || [];
  async function action(task: () => Promise<void>) { const current = epoch.current; setBusy(true); setError(''); setNotice(''); try { await task(); } catch (reason) { if (current === epoch.current) setError(message(reason)); } finally { if (current === epoch.current) setBusy(false); } }
  async function compare() {
    if (!enrollment || !observations.some(row => row.id === observationId)) throw new Error('Choose a committed observation for the selected enrollment.');
    const key = `${enrollmentId}|${observationId}|${scope}`;
    let idempotencyKey = retryKeys.current.get(key); if (!idempotencyKey) { idempotencyKey = crypto.randomUUID(); retryKeys.current.set(key, idempotencyKey); }
    const current = epoch.current;
    await transport.compare(proofId, { enrollmentId, observationId, requestedScope: scope, idempotencyKey });
    if (current !== epoch.current) return;
    retryKeys.current.delete(key);
    setNotice('Research analysis requested. The original Proof remains sealed.'); await refresh();
  }
  async function showSource(source: SurfaceSource, record: SurfaceRecord) {
    const current = epoch.current; const value = await transport.source(proofId, source);
    if (current !== epoch.current) { value.release?.(); return; } setPreview({ ...value, source, record });
  }
  return <section className="surface-panel" aria-label="Experimental surface fingerprint research">
    <div className="surface-row"><div><span className="surface-eyebrow">EXPERIMENTAL R&amp;D</span><h3>Surface fingerprint research</h3></div><span className="surface-tag">Unqualified</span></div>
    <p>Review existing label and carton observations. This experimental feature does not establish unchanged contents, seal continuity, custody, or the cause of a difference.</p>
    {!optedIn ? <div className="surface-optin"><p>Research access is optional. Opening this panel reads committed records; comparison requests create an append-only analysis.</p><button type="button" onClick={() => setOptedIn(true)}>Open research review</button></div> : <>
      <p className="surface-warning">{platform === 'desktop' ? 'Desktop webcams' : 'Browser cameras'} are unqualified for surface fingerprint capture. Continue using normal packing video; use the native research capture workflow for new surface observations.</p>
      <div className="surface-row"><p className="surface-muted">No customer-visible physical findings are enabled.</p><div className="surface-actions"><button type="button" disabled={busy} onClick={() => void refresh()}>Refresh</button><button type="button" disabled={busy || !summary} onClick={() => void action(async () => { await transport.export(proofId); setNotice('Research export prepared. Review its source availability and reproducibility limits.'); })}>Export R&amp;D record</button></div></div>
      <p className="surface-muted">The JSON export contains records and digest commitments. Save permitted originals separately for replay; a surviving digest cannot recover expired media.</p>
      {error && <p className="surface-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {!summary && !error && <p role="status">Loading research observations…</p>}
      {summary && <>
        <p className="surface-muted">Profile: {summary.capabilities.profileId} · collection {summary.capabilities.collection ? 'enabled' : 'off'} · extraction {summary.capabilities.extraction ? 'enabled' : 'off'} · internal comparison {summary.capabilities.internalComparison ? 'enabled' : 'off'}</p>
        {!summary.enrollments.length && <div className="surface-empty"><h4>Not checked</h4><p>No surface enrollment has been committed for this Proof. The ordinary packing evidence is available independently.</p></div>}
        {summary.enrollments.length > 0 && <>
          <form className="surface-form" onSubmit={event => { event.preventDefault(); void action(compare); }}>
            <h4>Compare committed observations</h4><p>A tracking code selects a shipment; it does not contribute to physical similarity. Research comparisons use only the committed source references selected below.</p>
            <label>Enrollment<select value={enrollmentId} disabled={busy} onChange={event => { setEnrollmentId(event.target.value); setObservationId(''); }}><option value="">Select enrollment</option>{summary.enrollments.map(row => <option key={row.id} value={row.id}>{row.packageInstanceId} / {row.shipmentLegId} · {time(row.createdAt)} · {row.id}</option>)}</select></label>
            <label>Later observation<select value={observationId} disabled={busy || !enrollmentId} onChange={event => setObservationId(event.target.value)}><option value="">{enrollmentId && !observations.length ? 'No corresponding observation committed' : 'Select observation'}</option>{observations.map(row => <option key={row.id} value={row.id}>{human(row.contextStage)} · {time(row.createdAt)} · {row.id}</option>)}</select></label>
            <label>Requested scope<select value={scope} disabled={busy} onChange={event => setScope(event.target.value as SurfaceScope)}>{scopes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <button type="submit" disabled={busy || !enrollmentId || !observationId || !summary.capabilities.internalComparison}>{busy ? 'Working…' : 'Request research comparison'}</button>
            {!summary.capabilities.internalComparison && <p>Internal comparison is disabled by the server. Existing records remain readable.</p>}
          </form>
          <h4>Committed sources</h4>{[...summary.enrollments, ...summary.observations].map(record => <Observation key={record.id} record={record} busy={busy} onSource={(source, row) => void action(() => showSource(source, row))} />)}
        </>}
        <h4>Append-only analyses ({summary.comparisons.length})</h4>{summary.comparisons.length ? summary.comparisons.map(comparison => <Comparison key={comparison.id} comparison={comparison} />) : <p>No later comparison has been requested. Absence of a comparison is not evidence of a discrepancy.</p>}
      </>}
      {preview && <div ref={previewRef} tabIndex={-1} className="surface-preview" role="region" aria-label="Selected original review"><div className="surface-row"><h4>Selected original</h4><button type="button" onClick={() => setPreview(null)}>Close original</button></div><OriginalPreview key={preview.url} url={preview.url} source={preview.source} record={preview.record} busy={busy} save={() => void action(async () => { await transport.saveSource(proofId, preview.source); setNotice('Selected original prepared for saving. Its recorded digest is shown with the source.'); })} /></div>}
    </>}
  </section>;
}
