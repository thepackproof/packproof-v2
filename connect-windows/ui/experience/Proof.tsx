import { useEffect, useMemo, useRef, useState } from "react";
import type { OrderDetail } from "../workspace-types";
import { Icon } from "./Icon";
import {
  Dialog,
  Facts,
  SourceInspector,
  SourceDetails,
  type FocusLine,
  type ReadOriginal,
} from "./ProofInspect";
import {
  dateLabel,
  human,
  inScope,
  itemsInScope,
  modelProof,
  quantity,
  quantityStages,
  scalar,
  searchMatch,
  stagesFor,
  text,
  type Item,
  type QuantityKey,
  type Source,
} from "./ProofModel";
import "./Proof.css";

const sections = [
  ["Overview", "layers"],
  ["Items", "list"],
  ["Journey", "shipping"],
  ["Evidence", "records"],
  ["History", "activity"],
] as const;
type Section = (typeof sections)[number][0];
type Inspection =
  | { type: "source" | "metadata"; source: Source; focus?: FocusLine }
  | { type: "item"; item: Item }
  | { type: "claims"; item: Item; stage: QuantityKey; records: Source[] }
  | { type: "identity" | "freshness" | "review" };
export type ProofProps = {
  detail: OrderDetail;
  onBack: () => void;
  sourceNames?: Record<string, string>;
  readOriginal?: ReadOriginal;
  onOpenFullProof?: () => void;
  mode?: "live" | "draft" | "sample";
};
const count = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);
function RecordList({
  list,
  onOpen,
  journey = false,
}: {
  list: Source[];
  onOpen: (s: Source) => void;
  journey?: boolean;
}) {
  return (
    <div className="pf-list">
      {list.map((s) => (
        <button key={s.key} className="pf-record" onClick={() => onOpen(s)}>
          <Icon name={s.icon} size={30} />
          {journey && <span className="pf-when">{dateLabel(s.eventTime)}</span>}
          <span className="pf-record-main">
            <strong>{s.title}</strong>
            <small>{[s.fileName, s.locator].filter(Boolean).join(" · ") || s.origin}</small>
          </span>
          <span className="pf-record-side">{s.origin}　›</span>
        </button>
      ))}
    </div>
  );
}
export function Proof(props: ProofProps) {
  return <ProofRevision key={props.detail.proofId + "@" + props.detail.revision} {...props} />;
}
function ProofRevision({
  detail,
  onBack,
  sourceNames,
  readOriginal,
  onOpenFullProof,
  mode = "live",
}: ProofProps) {
  const model = useMemo(() => modelProof(detail, sourceNames), [detail, sourceNames]);
  const [section, setSection] = useState<Section>("Overview"),
    [scope, setScope] = useState(""),
    [filter, setFilter] = useState(""),
    [query, setQuery] = useState(""),
    [stack, setStack] = useState<Inspection[]>([]);
  const search = useRef<HTMLInputElement>(null),
    tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const scopeTitle = model.scopes.find((s) => s.key === scope)?.label || "Whole proof";
  const items = itemsInScope(model, scope),
    events = model.events.filter((s) => inScope(s, scope)),
    records = model.sources.filter((s) => inScope(s, scope));
  const origins = [...new Map(model.sources.map((s) => [s.originId || s.origin, s.origin])).entries()];
  const evidence = records.filter((s) => !filter || (s.originId || s.origin) === filter);
  const history = useMemo(() => {
    const entries = model.sources
      .filter((s) => s.received)
      .map((s) => ({
        source: s,
        time: s.received,
        label: "Source record received",
        key: s.key + ":receipt",
      }));
    for (const s of model.events) {
      const at = text(s.fields, "followUpRequestedAt"),
        request = text(s.fields, "followUpRequest");
      if (at && request)
        entries.push({ source: s, time: at, label: request + " requested", key: s.key + ":followup" });
    }
    return entries.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  }, [model]);
  const stages = stagesFor(items, model, scope),
    differences = items.filter((i) => i.difference);
  const issues = (detail.conflicts || []).filter(
    (note) => !!note && (!scope || items.some((i) => note.startsWith(i.id + ":"))),
  );
  const followUps = events.filter((s) =>
    text(s.fields, "followUpRequest", "followUpStatus", "followUpEvidenceState"),
  );
  const openFollowUps = followUps.filter(
    (s) => !["closed", "completed", "resolved"].includes(text(s.fields, "followUpStatus").toLowerCase()),
  );
  const follow = openFollowUps[0] || followUps[0],
    issueCount = differences.length + issues.length + openFollowUps.length;
  const identity = model.events.find((s) => s.kind === "order")?.fields || {};
  const customer = text(
      identity,
      "customerName",
      "CustomerName",
      "customer",
      "Customer",
      "SoldToName",
      "ShipToName",
    ),
    purchase = text(identity, "purchaseOrder", "purchaseOrderReference", "purchaseOrderNumber", "PONumber");
  const wholeStatus = text(identity, "fulfillmentStatus", "orderStatus"),
    plannedId = text(identity, "plannedShipmentReference"),
    plannedDate = text(identity, "plannedDeliveryDate");
  const updated = text(detail as unknown as Record<string, unknown>, "updatedAt");
  const clipped = (["events", "evidence", "lines"] as const).filter(
    (k) => (detail.totals?.[k] ?? 0) > detail[k].length,
  );
  const top = stack.at(-1);
  const push = (view: Inspection) => setStack((prev) => [...prev, view]);
  const openSource = (source: Source, focus?: FocusLine) => push({ type: "source", source, focus });
  const chooseTab = (name: Section) => {
    setSection(name);
    setQuery("");
  };
  const inspect = (item: Item) => push({ type: "item", item });
  const claim = (item: Item, stage: QuantityKey) => {
    const { sources } = quantity(model, item, stage, scope);
    if (sources.length === 1) openSource(sources[0], { id: item.id, quantityKey: stage });
    else push({ type: "claims", item, stage, records: sources });
  };
  const first = differences[0] || items[0],
    priority: QuantityKey[] = [
      "orderedQuantity",
      "loadedQuantity",
      "acknowledgedQuantity",
      "shippedQuantity",
      "pickedQuantity",
      "packedQuantity",
    ];
  const cards = first
    ? stages
        .filter(([k]) => quantity(model, first, k, scope).text)
        .sort(
          (a, b) =>
            (priority.includes(a[0]) ? priority.indexOf(a[0]) : 99) -
            (priority.includes(b[0]) ? priority.indexOf(b[0]) : 99),
        )
        .slice(0, 3)
    : [];
  const matches = query.trim()
    ? {
        items: items.filter((i) => searchMatch(query, i.label, i.id, i.unit, text(i.row, "sku"))),
        records: records.filter((s) =>
          searchMatch(
            query,
            s.title,
            s.fileName,
            s.origin,
            s.locator,
            ...s.refs.map((r) => r.id),
            ...Object.values(s.fields).map(scalar),
          ),
        ),
        issues: [...issues, ...differences.map((i) => i.difference)].filter((s) => searchMatch(query, s)),
      }
    : null;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (!stack.length) search.current?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [stack.length]);
  const title = mode === "draft" ? "Order preview" : "Proof " + detail.proofId;
  const rev =
    mode === "draft"
      ? "Selected source preview"
      : (mode === "sample" ? "Fictional example · " : "") + "Revision " + detail.revision;
  return (
    <article className="pf" aria-label={"Order proof " + detail.orderReference}>
      <button className="pf-link pf-back" onClick={onBack}>
        {mode === "draft" ? "‹　Back to setup" : mode === "sample" ? "‹　Back to sample" : "‹　All orders"}
      </button>
      <header className="pf-heading">
        <div>
          <h1>{title}</h1>
          <p>
            {[customer, "Order " + detail.orderReference, purchase ? "PO " + purchase : ""]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <small>
            {rev}
            {updated && " · Updated " + dateLabel(updated)}
          </small>
        </div>
        <span
          className={
            "pf-tag " +
            (detail.conflicts?.length || model.items.some((i) => i.difference) ? "warn" : "neutral")
          }
        >
          Whole proof ·{" "}
          {wholeStatus ||
            (detail.conflicts?.length || model.items.some((i) => i.difference)
              ? "Needs review"
              : "Order record")}
        </span>
      </header>
      <div className="pf-context">
        <div className="pf-scope">
          <Icon name="shipping" size={30} />
          <div>
            <label htmlFor="pf-scope">Fulfillment scope</label>
            <select id="pf-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Whole proof</option>
              {model.scopes.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <small>
              {count(items.length, "item")}
              {model.scopes.length > 0 && " · " + count(model.scopes.length, "fulfillment reference")}
            </small>
          </div>
        </div>
        <div className="pf-search">
          <Icon name="search" size={26} />
          <input
            ref={search}
            type="search"
            aria-label="Search this proof"
            placeholder="Search this proof…"
            value={query}
            maxLength={240}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
          />
        </div>
      </div>
      <div className="pf-tabs" role="tablist" aria-label="Proof sections">
        {sections.map(([name, icon], i) => (
          <button
            key={name}
            id={"pf-tab-" + name}
            ref={(n) => {
              tabRefs.current[i] = n;
            }}
            role="tab"
            aria-selected={section === name}
            tabIndex={section === name ? 0 : -1}
            aria-controls="pf-panel"
            onClick={() => chooseTab(name)}
            onKeyDown={(e) => {
              const offset = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              const idx =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? sections.length - 1
                    : offset
                      ? (i + offset + sections.length) % sections.length
                      : i;
              if (idx !== i) {
                e.preventDefault();
                chooseTab(sections[idx][0]);
                tabRefs.current[idx]?.focus();
              }
            }}
          >
            <Icon name={icon} size={30} />
            {name}
          </button>
        ))}
      </div>
      {clipped.length > 0 && (
        <div className="pf-note">
          Showing a portion of this revision’s {clipped.join(", ")}.{" "}
          {onOpenFullProof && (
            <button className="pf-link" onClick={onOpenFullProof}>
              Open full online order
            </button>
          )}
        </div>
      )}
      <div id="pf-panel" role="tabpanel" aria-labelledby={"pf-tab-" + section}>
        {matches ? (
          <section className="pf-card">
            <div className="pf-sectionhead">
              <h2>Search results</h2>
              <button className="pf-link" onClick={() => setQuery("")}>
                Clear search
              </button>
            </div>
            <p className="pf-muted">
              {scopeTitle} ·{" "}
              {count(
                matches.items.length + matches.records.length + matches.issues.length,
                "match",
                "matches",
              )}
            </p>
            {matches.items.map((i) => (
              <button key={i.id} className="pf-record" onClick={() => inspect(i)}>
                <Icon name="list" size={30} />
                <span className="pf-record-main">
                  <strong>{i.label}</strong>
                  <small>{i.id}</small>
                </span>
                ›
              </button>
            ))}
            <RecordList list={matches.records} onOpen={openSource} />
            {matches.issues.map((s, i) => (
              <button key={i} className="pf-record" onClick={() => push({ type: "review" })}>
                <Icon name="attention" size={30} />
                <strong>{s}</strong>
              </button>
            ))}
            {!matches.items.length && !matches.records.length && !matches.issues.length && (
              <p>No matching items, records, or review notes in this scope.</p>
            )}
          </section>
        ) : section === "Overview" ? (
          <div className="pf-overview">
            <section className="pf-card pf-summary">
              <div className="pf-titleicon">
                <Icon name={issueCount ? "attention" : "records"} size={36} />
                <div>
                  <h2>
                    {differences[0]?.difference ||
                      (issues.length ? "Source records need review" : "Order summary")}
                  </h2>
                  <p className="pf-muted">
                    {differences.length
                      ? differences[0].id + " · " + differences[0].label
                      : issues.length
                        ? "Reported values differ across sources."
                        : detail.orderReference + " · " + scopeTitle}
                  </p>
                </div>
              </div>
              {first && cards.length ? (
                <div className="pf-quantities">
                  {cards.map(([k, label]) => {
                    const q = quantity(model, first, k, scope);
                    return (
                      <button key={k} onClick={() => claim(first, k)}>
                        <small>{label}</small>
                        <strong>
                          {q.text} {q.unit}
                        </strong>
                        <span>
                          {q.orderContext
                            ? "Whole order"
                            : q.sources.length === 1
                              ? q.sources[0].origin
                              : q.sources.length
                                ? count(q.sources.length, "source")
                                : "Quantity details"}{" "}
                          ›
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p>
                  {count(items.length, "item")} · {count(events.length, "reported event")} ·{" "}
                  {count(records.length, "source record")}
                </p>
              )}
              <button
                className="pf-link"
                onClick={() =>
                  differences.length
                    ? inspect(differences[0])
                    : chooseTab(issues.length ? "Evidence" : "Items")
                }
              >
                {differences.length
                  ? "Compare the quantity records"
                  : issues.length
                    ? "Inspect the source records"
                    : "View items and quantities"}
                　›
              </button>
            </section>
            <section className="pf-card pf-follow">
              <h2>What needs follow-up</h2>
              <span className={"pf-tag " + (issueCount ? "warn" : "neutral")}>
                {follow
                  ? human(text(follow.fields, "followUpStatus") || "Follow-up recorded")
                  : issueCount
                    ? "Review needed"
                    : "No review flags"}
              </span>
              {follow ? (
                <>
                  <h3>{text(follow.fields, "followUpRequest") || "Follow-up"}</h3>
                  {text(follow.fields, "followUpRequestedAt") && (
                    <p>Requested {dateLabel(text(follow.fields, "followUpRequestedAt"))}.</p>
                  )}
                  {text(follow.fields, "followUpEvidenceState").toLowerCase() === "missing" && (
                    <p>A response is still missing.</p>
                  )}
                  {text(follow.fields, "followUpOwner") && (
                    <Facts pairs={[["Review owner", text(follow.fields, "followUpOwner")]]} />
                  )}
                  <button className="pf-link" onClick={() => openSource(follow)}>
                    Inspect follow-up record　›
                  </button>
                  {followUps.length + issues.length > 1 && (
                    <button className="pf-link" onClick={() => push({ type: "review" })}>
                      View all review notes　›
                    </button>
                  )}
                </>
              ) : issueCount ? (
                <>
                  <h3>{differences[0]?.label || "Conflicting source reports"}</h3>
                  <p>{differences[0]?.difference || issues[0]}</p>
                  <button className="pf-link" onClick={() => push({ type: "review" })}>
                    Review the records　›
                  </button>
                </>
              ) : (
                <p>
                  {events.length
                    ? "No quantity differences or conflicting fields were reported for this view."
                    : "Waiting for source records."}
                </p>
              )}
            </section>
            <section className="pf-card pf-deliveries">
              <h3>Fulfillment journey</h3>
              <div className="pf-deliverygrid">
                {model.scopes
                  .filter((s) => !scope || s.key === scope)
                  .map((s) => (
                    <button
                      key={s.key}
                      onClick={() => {
                        setScope(s.key);
                        chooseTab("Journey");
                      }}
                    >
                      <Icon name={s.ref.id === plannedId ? "clock" : "shipping"} size={32} />
                      <span>
                        <strong>{s.label}</strong>
                        <small>
                          {s.ref.id === plannedId
                            ? "Planned" + (plannedDate ? " · " + plannedDate : "")
                            : count(model.events.filter((e) => inScope(e, s.key)).length, "linked event")}
                        </small>
                      </span>
                    </button>
                  ))}
                {!model.scopes.length && (
                  <button onClick={() => chooseTab("Journey")}>
                    <Icon name="shipping" size={32} />
                    <span>
                      <strong>Order journey</strong>
                      <small>{count(events.length, "reported event")}</small>
                    </span>
                  </button>
                )}
              </div>
            </section>
          </div>
        ) : section === "Items" ? (
          <section className="pf-card">
            <h2>Items and quantities</h2>
            <p className="pf-muted">Select a reported value to inspect its source.</p>
            {items.length ? (
              <div className="pf-tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th>
                      {stages.map(([k, name]) => (
                        <th key={k}>{name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id}>
                        <th scope="row">
                          <button className="pf-itemlink" onClick={() => inspect(i)}>
                            {i.label}
                          </button>
                          <small>
                            {[i.id, text(i.row, "sku") !== i.label ? text(i.row, "sku") : "", i.difference]
                              .filter(Boolean)
                              .join(" · ")}
                          </small>
                        </th>
                        {stages.map(([k, label]) => {
                          const q = quantity(model, i, k, scope),
                            state = text(i.row, k + "State");
                          return (
                            <td key={k}>
                              {q.text ? (
                                <button
                                  className="pf-link"
                                  aria-label={
                                    i.label + ": " + label + " " + [q.text, q.unit].filter(Boolean).join(" ")
                                  }
                                  onClick={() => claim(i, k)}
                                >
                                  {q.text} {q.unit}
                                  {q.orderContext && <small>Whole order</small>}
                                </button>
                              ) : (
                                <span className="pf-muted">
                                  {state === "not_due"
                                    ? "Not due"
                                    : state === "missing"
                                      ? "Missing"
                                      : state === "unavailable"
                                        ? "Unavailable"
                                        : "Not recorded"}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <>
                <p>No line items have been reported for this scope.</p>
                <button className="pf-link" onClick={() => chooseTab("Evidence")}>
                  View available records　›
                </button>
              </>
            )}
          </section>
        ) : section === "Journey" ? (
          <section className="pf-card">
            <h2>Fulfillment journey</h2>
            <p className="pf-muted">{scopeTitle} · Events in source-reported order</p>
            {events.length ? (
              <RecordList list={events} journey onOpen={openSource} />
            ) : (
              <p>No fulfillment events are linked to this scope yet.</p>
            )}
          </section>
        ) : section === "Evidence" ? (
          <section className="pf-card">
            <div className="pf-sectionhead">
              <div>
                <h2>Source evidence</h2>
                <p className="pf-muted">{count(evidence.length, "record")} in this view</p>
              </div>
              <select
                aria-label="Filter evidence by source"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">All sources</option>
                {origins.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            {evidence.length ? (
              <RecordList list={evidence} onOpen={openSource} />
            ) : (
              <p>No source records match this view.</p>
            )}
          </section>
        ) : (
          <section className="pf-card">
            <h2>{mode === "draft" ? "Preview history" : "Proof history · revision " + detail.revision}</h2>
            <p className="pf-muted">Whole proof · Source receipts and reported follow-up activity</p>
            {history.length ? (
              <div className="pf-list">
                {history.map((e) => (
                  <button className="pf-record" key={e.key} onClick={() => openSource(e.source)}>
                    <Icon name="activity" size={30} />
                    <span className="pf-when">{dateLabel(e.time)}</span>
                    <span className="pf-record-main">
                      <strong>{e.label}</strong>
                      <small>{e.source.fileName || e.source.origin}</small>
                    </span>
                    <span className="pf-record-side">›</span>
                  </button>
                ))}
              </div>
            ) : (
              <p>Source receipt times have not been reported for this revision.</p>
            )}
            {mode !== "draft" && updated && (
              <p className="pf-muted">
                Revision {detail.revision} saved {dateLabel(updated)}.
              </p>
            )}
          </section>
        )}
      </div>
      <footer className="pf-foot">
        <button className="pf-link" onClick={() => push({ type: "identity" })}>
          Record details
        </button>
        <button className="pf-link" onClick={() => push({ type: "freshness" })}>
          Source activity　›
        </button>
      </footer>
      {top && (
        <Dialog
          title={
            top.type === "source"
              ? top.source.title
              : top.type === "metadata"
                ? "Source details"
                : top.type === "item" || top.type === "claims"
                  ? top.item.label
                  : top.type === "identity"
                    ? "Record details"
                    : top.type === "review"
                      ? "What needs follow-up"
                      : "Source activity"
          }
          subtitle={
            top.type === "source" || top.type === "metadata"
              ? [top.source.origin, top.source.fileName].filter(Boolean).join(" · ")
              : title + " · " + rev
          }
          icon={
            top.type === "source" || top.type === "metadata"
              ? top.source.icon
              : top.type === "review"
                ? "attention"
                : top.type === "freshness"
                  ? "activity"
                  : "records"
          }
          back={stack.length > 1 ? () => setStack((s) => s.slice(0, -1)) : undefined}
          close={() => setStack([])}
        >
          {top.type === "source" ? (
            <SourceInspector
              key={top.source.key}
              source={top.source}
              focus={top.focus}
              proofId={detail.proofId}
              revision={detail.revision}
              readOriginal={mode === "draft" ? undefined : readOriginal}
              onDetails={(source) => push({ ...top, source, type: "metadata" })}
            />
          ) : top.type === "metadata" ? (
            <SourceDetails source={top.source} />
          ) : top.type === "item" ? (
            <>
              <Facts
                pairs={[
                  ["Line", top.item.id],
                  ["SKU", text(top.item.row, "sku")],
                  ["Unit", top.item.unit],
                  ["Scope", scopeTitle],
                ]}
              />
              {top.item.difference && <p className="pf-note">{top.item.difference}</p>}
              <div className="pf-list">
                {stages.map(([k, label]) => {
                  const q = quantity(model, top.item, k, scope);
                  return q.text ? (
                    <button className="pf-record" key={k} onClick={() => claim(top.item, k)}>
                      <span>{label}</span>
                      <strong className="pf-record-main">
                        {q.text} {q.unit}
                        {q.orderContext && " · Whole order"}
                      </strong>
                      <span>›</span>
                    </button>
                  ) : null;
                })}
              </div>
            </>
          ) : top.type === "claims" ? (
            <>
              <h3>{quantityStages.find(([k]) => k === top.stage)?.[1]} · Source observations</h3>
              {top.records.length ? (
                <RecordList
                  list={top.records}
                  onOpen={(s) => openSource(s, { id: top.item.id, quantityKey: top.stage })}
                />
              ) : (
                <p>
                  The quantity is present in this revision. No linked source observations for this value are
                  available here.
                </p>
              )}
            </>
          ) : top.type === "identity" ? (
            <>
              <Facts
                pairs={[
                  [
                    mode === "draft" ? "Preview" : "Proof ID",
                    mode === "draft" ? detail.orderReference : detail.proofId,
                  ],
                  ["Order", detail.orderReference],
                  [
                    mode === "draft" ? "Status" : "Revision",
                    mode === "draft" ? "Local preview" : String(detail.revision),
                  ],
                  ["Updated", dateLabel(updated)],
                  ["Customer", customer],
                  ["Purchase order", purchase],
                  [
                    "Packages",
                    (detail.packages || [])
                      .map((p) => text(p, "packageId", "id"))
                      .filter(Boolean)
                      .join(", "),
                  ],
                ]}
              />
              {mode === "live" && onOpenFullProof && (
                <button className="pf-link" onClick={onOpenFullProof}>
                  Open online order　›
                </button>
              )}
            </>
          ) : top.type === "freshness" ? (
            <>
              <p>Latest receipt visible for each source in this Proof.</p>
              <Facts
                pairs={origins.map(([id, name]) => {
                  const times = model.sources
                    .filter((s) => (s.originId || s.origin) === id && s.received)
                    .map((s) => s.received)
                    .sort((a, b) => Date.parse(b) - Date.parse(a));
                  return [name, dateLabel(times[0] || "")];
                })}
              />
              {!origins.length && <p>No source activity has arrived.</p>}
            </>
          ) : (
            <>
              {differences.map((i) => (
                <button className="pf-record" key={i.id} onClick={() => inspect(i)}>
                  <Icon name="attention" size={30} />
                  <span className="pf-record-main">
                    <strong>{i.difference}</strong>
                    <small>{i.label}</small>
                  </span>
                  ›
                </button>
              ))}
              {issues.map((s, i) => (
                <p className="pf-note" key={i}>
                  {s}
                </p>
              ))}
              {followUps.map((s) => (
                <button className="pf-record" key={s.key} onClick={() => openSource(s)}>
                  <Icon name="activity" size={30} />
                  <span className="pf-record-main">
                    <strong>{text(s.fields, "followUpRequest") || "Follow-up"}</strong>
                    <small>{text(s.fields, "followUpOwner", "followUpStatus")}</small>
                  </span>
                  ›
                </button>
              ))}
              <button
                className="pf-link"
                onClick={() => {
                  setStack([]);
                  chooseTab("Evidence");
                }}
              >
                Inspect source evidence　›
              </button>
            </>
          )}
        </Dialog>
      )}
    </article>
  );
}
