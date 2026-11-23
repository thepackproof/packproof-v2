import { Icon } from "./Icon";
import { dateLabel, type Source } from "./ProofModel";
import "./ProofJourney.css";

type Props = {
  orderReference: string;
  revision: number;
  events: Source[];
  records: Source[];
  onJourney: () => void;
  onEvidence: () => void;
};

/**
 * Figma Evidence OS 4:122: a single order's evolving, source-attributed Proof.
 * Derived from the authorized canonical revision — no fictional milestones,
 * unsupported integrity claims or synthetic event dates.
 */
export function ProofJourney({orderReference,revision,events,records,onJourney,onEvidence}: Props) {
  const orderOf = (s:Source) => {
    const at = Date.parse(s.eventTime || s.received);
    return Number.isFinite(at) ? at : null;
  };
  const chronology = [...events].sort((a,b)=>{
    const ta=orderOf(a),tb=orderOf(b);
    return ta !== null && tb !== null ? ta-tb : 0;
  }).slice(-5);
  const grouped = new Map<string,{name:string;count:number;hashes:number}>();
  const validHash = (value:string) => /^[a-f0-9]{64}$/i.test(value);
  for(const source of records) {
    const key=source.originId || source.origin;
    const group=grouped.get(key) || {name:source.origin,count:0,hashes:0};
    group.count++;
    if(validHash(source.hash)) group.hashes++;
    grouped.set(key,group);
  }
  const countHash=records.filter(s=>validHash(s.hash)).length;
  return (
    <section className="pf-eos-journey" aria-label={"Evolving evidence journey for " + orderReference}
      data-design-file="nNnkgTZOBNkG8muy8AkIv1" data-design-node="4:122">
      <div className="pf-eos-journey-grid">
        <article className="pf-eos-chronology">
          <div className="pf-eos-block-heading">
            <div><span className="pf-eos-eyebrow">ONE EVOLVING PROOF</span>
              <h2>What happened to this order</h2>
              <p>Actual source events · revision {revision}</p></div>
            <Icon name="activity" size={30}/>
          </div>
          {chronology.length ? (
            <ol className="pf-eos-timeline">
              {chronology.map((event,i)=>(
                <li key={event.key} style={{animationDelay: String(i*65)+"ms"}}>
                  <span className="pf-eos-timeline-dot" aria-hidden="true"/>
                  <span className="pf-eos-when">{event.eventTime ? dateLabel(event.eventTime) :
                    event.received ? "Observed " + dateLabel(event.received) : "Time not reported"}</span>
                  <span className="pf-eos-event">
                    <strong>{event.title}</strong>
                    <small>{event.origin} · {event.fileName || "Source record"}</small>
                  </span>
                </li>
              ))}
            </ol>
          ) : <p className="pf-eos-empty">No timeline events were reported in this Proof scope.</p>}
          <button className="pf-eos-link" type="button" onClick={onJourney}>View complete journey <span aria-hidden="true">→</span></button>
        </article>
        <article className="pf-eos-sources">
          <div className="pf-eos-block-heading">
            <div><span className="pf-eos-eyebrow">EVIDENCE, LINKED TO ITS SOURCE</span>
              <h2>Evidence collected</h2>
              <p>{grouped.size} identified source(s) · {records.length} source record(s)</p></div>
            <Icon name="records" size={30}/>
          </div>
          {grouped.size ? <div className="pf-eos-source-rows">
            {[...grouped].slice(0,5).map(([id,group],i)=>(
              <button type="button" className="pf-eos-source-entry" key={id} onClick={onEvidence}
                style={{animationDelay: String(i*70)+"ms"}}>
                <span className="pf-eos-source-light" aria-hidden="true"/>
                <span><strong>{group.name}</strong>
                  <small>{group.count} record(s) · {group.hashes} original SHA-256 digest(s) recorded</small></span>
                <span className="pf-eos-chevron" aria-hidden="true">›</span>
              </button>
            ))}
            {grouped.size>5&&<p className="pf-eos-extra">Additional sources are available in the Evidence tab.</p>}
          </div> : <p className="pf-eos-empty">No source records are visible in this Proof scope.</p>}
        </article>
      </div>
      <div className="pf-eos-trust">
        <Icon name="approval" size={29}/>
        <div><strong>Evidence integrity</strong>
          <p>{countHash} of {records.length} visible source records have an original SHA-256 digest recorded.
            A recorded digest is not, by itself, proof of a successful re-verification.</p></div>
        <button type="button" className="pf-eos-link" onClick={onEvidence}>Inspect original evidence <span aria-hidden="true">→</span></button>
      </div>
    </section>
  );
}
