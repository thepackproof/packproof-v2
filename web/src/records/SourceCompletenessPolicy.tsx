import { useState } from 'react';
import type { PackProofApi } from '../api/client';
import type { SourceSubscription } from './SourceSubscriptions';
import { nextSourceConfig } from './source-config-revision';
import { useWorkflowCommand } from './workflow';

const profiles = new Set(['packproof.order-lines/v1', 'packproof.shipment-handling-units/v1', 'packproof.operational-observations/v1', 'packproof.operational-observations/v2']);
const scopes = [
  ['shipment_line', 'Shipment lines and allocations'],
  ['tracking_package', 'Tracking packages'],
  ['handling_unit_set', 'Declared handling-unit inventory'],
] as const;
type Props = { api: PackProofApi; source: SourceSubscription; organizationId: string; environment: string; onSaved: (source: SourceSubscription) => void };

export function SourceCompletenessPolicy(props: Props) {
  const { source } = props, boundary = source.config.completenessPolicy.fileBoundary;
  const available = source.state !== 'revoked' && source.capabilities?.csvSnapshotBoundary === true && source.config.transport === 'local_ntfs'
    && source.config.batchSchema === 'packproof.typed-source-batch/v2' && profiles.has(source.config.sourceProfile);
  return <div className="source-policy-review">
    <h3>Exporter snapshot completeness controls</h3>
    {boundary ? <><p>This source configuration binds the existing exporter columns below. Source-owner qualification and exact source revision approval are required. Each original must contain consistent actual control values before a complete boundary can be measured.</p><dl className="records-facts"><div><dt>Snapshot marker column</dt><dd>{boundary.markerColumn}</dd></div><div><dt>Snapshot as-of column</dt><dd>{boundary.asOfColumn}</dd></div><div><dt>Snapshot data-row count column</dt><dd>{boundary.rowCountColumn}</dd></div><div><dt>Snapshot inventory scope</dt><dd>{scopes.find(([value]) => value === source.config.completenessPolicy.scope)?.[1] || source.config.completenessPolicy.scope}</dd></div><div><dt>Snapshot qualification reference</dt><dd>{source.config.completenessPolicy.qualificationReference || 'Not qualified'}</dd></div></dl></> : <p>Snapshot controls are unknown. A recent file or matching row count alone does not establish that the source supplied a complete snapshot.</p>}
    <p>A source boundary describes the qualified exporter’s report. It does not verify physical contents or establish completeness for another source.</p>
    {available ? <CompletenessEditor key={`${props.organizationId}.${props.environment}.${source.id}.${source.configurationRevision}.${source.configurationSha256}`} {...props}/> : <p>Configuring CSV snapshot controls requires a matching collector capability, a version two batch contract and an approved local CSV source. Existing recorded controls remain visible for review.</p>}
  </div>;
}

function CompletenessEditor({ api, source, organizationId, environment, onSaved }: Props) {
  const initial = source.config.completenessPolicy, boundary = initial.fileBoundary;
  const [enabled, setEnabled] = useState(!!boundary), [marker, setMarker] = useState(boundary?.markerColumn || ''),
    [asOf, setAsOf] = useState(boundary?.asOfColumn || ''), [rowCount, setRowCount] = useState(boundary?.rowCountColumn || '');
  const [scopeValue, setScopeValue] = useState(initial.scope), [reference, setReference] = useState(initial.qualificationReference || '');
  const [qualified, setQualified] = useState(false), [consent, setConsent] = useState(false), [saved, setSaved] = useState(false);
  const scope = new URLSearchParams({ organizationId, environment }).toString();
  const command = useWorkflowCommand(api, `${scope}.${source.id}.${source.configurationRevision}.${source.configurationSha256}.snapshot-controls`);
  const columns = [...new Set(source.config.expectedHeaders)];
  const distinct = new Set([marker, asOf, rowCount]).size === 3;
  const columnsValid = distinct && [marker, asOf, rowCount].every(column => !!column && columns.includes(column));
  const valid = scopes.some(([value]) => value === scopeValue) && (!enabled || columnsValid && qualified && !!reference.trim());
  const disabled = command.busy || saved;
  function change(update: () => void) { update(); setQualified(false); setConsent(false); }
  function column(label: string, value: string, update: (value: string) => void) {
    return <label>{label}<select value={value} disabled={disabled} onChange={event => change(() => update(event.target.value))}><option value="">Choose an existing export column</option>{columns.map(header => <option key={header} value={header}>{header}</option>)}</select></label>;
  }
  async function save() {
    if (!valid || !consent || disabled) return;
    const completenessPolicy: SourceSubscription['config']['completenessPolicy'] = enabled ? {
      kind: 'snapshot', scope: scopeValue, sourceOwnerQualified: true, qualificationReference: reference.trim(),
      fileBoundary: { schema: 'packproof.csv-snapshot-boundary/v1', markerColumn: marker, asOfColumn: asOf, rowCountColumn: rowCount },
    } : { kind: 'unknown', scope: scopeValue, sourceOwnerQualified: false, qualificationReference: null };
    const value = await command.run<SourceSubscription>(`/source-subscriptions/${encodeURIComponent(source.id)}/actions?${scope}`, {
      organizationId, environment, action: 'revise', configurationRevision: source.configurationRevision,
      config: nextSourceConfig(source, { completenessPolicy }),
    });
    if (value) { setSaved(true); setConsent(false); onSaved(value); }
  }
  return <details className="source-approval-action source-policy-editor">
    <summary>Configure snapshot completeness controls</summary>
    <p>Select actual columns already present in the approved export. PackProof checks the complete original for one consistent marker, explicit snapshot time and expected number of data rows. It does not create missing exporter controls or substitute receipt time.</p>
    <p>This saves a new source revision for separate review. Existing queued work retains its original configuration and grant.</p>
    <label className="agent-check"><input type="checkbox" checked={enabled} disabled={disabled} onChange={event => change(() => setEnabled(event.target.checked))}/>Use existing exporter snapshot control columns</label>
    {enabled ? <><div className="source-policy-grid">{column('Snapshot marker column', marker, setMarker)}{column('Snapshot as-of column', asOf, setAsOf)}{column('Snapshot data-row count column', rowCount, setRowCount)}</div>
      <p>The three control roles must use distinct approved columns. An existing source snapshot-time column may also be used as the snapshot as-of control. The expected data-row count is an exporter control, separate from item quantities.</p>
      {!columnsValid && <p role="status">Choose three distinct columns from the exact approved export headers.</p>}
      <label>Snapshot inventory scope<select value={scopeValue} disabled={disabled} onChange={event => change(() => setScopeValue(event.target.value))}>{scopes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Snapshot completeness qualification reference<input value={reference} maxLength={500} disabled={disabled} onChange={event => change(() => setReference(event.target.value))}/></label>
      <label className="agent-check"><input type="checkbox" checked={qualified} disabled={disabled} onChange={event => { setQualified(event.target.checked); setConsent(false); }}/>The source owner confirmed these exporter controls describe the complete snapshot for this inventory scope.</label>
    </> : <p>Saving without snapshot control columns records unknown completeness and removes any previous CSV snapshot boundary. Received assertions remain available.</p>}
    <label className="agent-check"><input type="checkbox" checked={consent} disabled={disabled} onChange={event => setConsent(event.target.checked)}/>Save these exact completeness controls as a new source revision for separate approval.</label>
    <button className="records-button secondary" disabled={!valid || !consent || disabled} onClick={() => void save()}>Save completeness policy for review</button>
    {command.error && <p role="alert" className="records-error-text">{command.error}</p>}
    {saved && <p role="status">Completeness policy saved for review. Approve the exact new source revision before collection may use these controls.</p>}
  </details>;
}
