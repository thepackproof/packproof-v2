interface SourceLineage {
  receiptId: string; sourceEventId: string | null; sourceKind: string | null; sourceSchemaVersion: string | null;
  mappingVersion: string | null; ruleVersion: string | null; receivedAt: string | null; reference: string | null; payloadSha256: string | null;
}
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === 'string' && value ? value : null;
export function readSourceLineage(data?: Record<string, unknown>): SourceLineage | null {
  const source = object(data?.sourceObservation), receiptId = text(source?.receiptId);
  if (!source || !receiptId) return null;
  const reference = object(source.reference), externalId = text(reference?.externalId), type = text(reference?.type);
  return { receiptId, sourceEventId: text(source.sourceEventId), sourceKind: text(source.sourceKind), sourceSchemaVersion: text(source.sourceSchemaVersion), mappingVersion: text(source.mappingVersion), ruleVersion: text(source.ruleVersion), receivedAt: text(source.receivedAt), reference: externalId ? `${type || 'Reference'} · ${externalId}` : null, payloadSha256: text(source.payloadSha256) };
}
export function SourceLineageFacts({ lineage }: { lineage: SourceLineage | null }) {
  if (!lineage) return null;
  const parsed = lineage.receivedAt ? new Date(lineage.receivedAt) : null;
  const receivedAt = parsed && Number.isFinite(parsed.getTime()) ? parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not reported';
  return <div className="records-source-lineage"><p>Organization-submitted source assertion. This operational addition is outside the inventory of earlier signed snapshots.</p><dl className="records-facts">
    <div><dt>Source system</dt><dd>{lineage.sourceKind || 'Not reported'}</dd></div>
    <div><dt>Source schema</dt><dd>{lineage.sourceSchemaVersion || 'Not reported'}</dd></div>
    <div><dt>Source reference</dt><dd>{lineage.reference || 'Not reported'}</dd></div>
    <div><dt>Original source receipt received</dt><dd>{receivedAt}</dd></div>
    <div><dt>Source interpretation</dt><dd>{lineage.mappingVersion || 'Not reported'}</dd></div>
    <div><dt>Matching rule</dt><dd>{lineage.ruleVersion || 'Not reported'}</dd></div>
    <div><dt>Preserved receipt</dt><dd>{lineage.receiptId}</dd></div>
    <div><dt>Source event</dt><dd>{lineage.sourceEventId || 'Not reported'}</dd></div>
    <div><dt>Source payload digest</dt><dd><code>{lineage.payloadSha256 || 'Not reported'}</code></dd></div>
  </dl></div>;
}
