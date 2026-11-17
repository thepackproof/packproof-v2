type Columns = {expectedHeaders: string[]; mapping?: Record<string,string>};

export function ColumnChangeReview({previous, proposed}: {previous: Columns; proposed: Columns}) {
  const added = proposed.expectedHeaders.filter(name => !previous.expectedHeaders.includes(name));
  const removed = previous.expectedHeaders.filter(name => !proposed.expectedHeaders.includes(name));
  const reordered = !added.length && !removed.length && proposed.expectedHeaders.some((name, i) => name !== previous.expectedHeaders[i]);
  const roles = new Set([...Object.keys(previous.mapping ?? {}), ...Object.keys(proposed.mapping ?? {})]);
  const changed = Array.from(roles).filter(field => previous.mapping?.[field] !== proposed.mapping?.[field]);
  if (!added.length && !removed.length && !reordered && !changed.length) return null;
  return <section><h3>Changes from the previous configuration</h3>
    {!!added.length && <p>These additional columns will be preserved in full if approved: {added.join(', ')}.</p>}
    {!!removed.length && <p>These columns are missing from the proposed report: {removed.join(', ')}.</p>}
    {reordered && <p>The report contains the same columns in a different order.</p>}
    {!!changed.length && <dl className="records-facts">{changed.map(field=><div key={field}><dt>{field.replace(/([a-z])([A-Z])/g,'$1 $2')}</dt><dd>{previous.mapping?.[field] ?? 'Unmapped'} → {proposed.mapping?.[field] ?? 'Unmapped'}</dd></div>)}</dl>}
  </section>;
}
