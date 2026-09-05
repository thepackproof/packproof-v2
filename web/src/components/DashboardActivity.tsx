import { useState } from "react";
import type { ProofCollectionItem } from "../api/types";
import { Glyph } from "../site/Brand";

export function proofActivity(proofs: Pick<ProofCollectionItem, "createdAt" | "finalizedAt">[], days: number, now = new Date()) {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(end); date.setDate(date.getDate() - days + index + 1);
    const next = new Date(date); next.setDate(next.getDate() + 1);
    return { date, created: 0, finalized: 0, start: date.getTime(), end: next.getTime() };
  });
  for (const proof of proofs) {
    for (const field of ["createdAt", "finalizedAt"] as const) {
      const time = proof[field] ? new Date(proof[field]!).getTime() : NaN;
      const bucket = time <= now.getTime() ? buckets.find(day => time >= day.start && time < day.end) : undefined;
      if (bucket) bucket[field === "createdAt" ? "created" : "finalized"]++;
    }
  }
  return buckets;
}

export function DashboardActivity({ proofs, unavailable = false }: { proofs: ProofCollectionItem[]; unavailable?: boolean }) {
  const [days, setDays] = useState(7);
  const data = proofActivity(unavailable ? [] : proofs, days);
  const total = data.reduce((sum, day) => sum + day.created, 0);
  const finalized = data.reduce((sum, day) => sum + day.finalized, 0);
  const max = Math.max(1, ...data.flatMap(day => [day.created, day.finalized]));
  return <section className="dashboard-activity" aria-label="Proof activity">
    <div className="panel-heading"><div><span className="panel-eyebrow"><Glyph name="activity" size={15} /> WORKSPACE PULSE</span><h2>Proof activity</h2></div><div className="compact-switch" aria-label="Activity period">{[7, 30].map(value => <button key={value} aria-pressed={days === value} onClick={() => setDays(value)}>{value} days</button>)}</div></div>
    <div className="activity-summary"><strong>{unavailable ? "—" : total}</strong><span>Proofs created <span className="summary-separator">/</span> {unavailable ? "—" : finalized} finalized</span></div>
    <div className="activity-chart" role="img" aria-label={unavailable ? "Activity unavailable" : `${total} Proofs created and ${finalized} finalized in the last ${days} days. Daily values below.`}>
      <div className="chart-grid" aria-hidden="true"><span>{unavailable ? "—" : max}</span><span>0</span></div>
      <div className="chart-columns">{data.map(day => <div className="chart-column" key={day.start} title={`${day.date.toLocaleDateString()}: ${day.created} created, ${day.finalized} finalized`}><div style={{ height: `${day.created / max * 100}%` }} className="chart-bar created-bar" /><div style={{ height: `${day.finalized / max * 100}%` }} className="chart-bar finalized-bar" /></div>)}</div>
      {unavailable || (!total && !finalized) ? <div className="chart-empty">{unavailable ? "Activity will appear when your records load." : "Your next Proof starts the story."}</div> : null}
    </div>
    <div className="chart-axis"><span>{data[0].date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span><div><span className="legend-created" /> Created <span className="legend-finalized" /> Finalized</div><span>Today</span></div>
    {!unavailable && <details className="chart-data"><summary>Daily activity details</summary><table><caption>Proof activity in your local time</caption><thead><tr><th>Date</th><th>Created</th><th>Finalized</th></tr></thead><tbody>{data.map(day => <tr key={day.start}><th>{day.date.toLocaleDateString()}</th><td>{day.created}</td><td>{day.finalized}</td></tr>)}</tbody></table></details>}
  </section>;
}
