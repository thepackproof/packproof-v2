import { useState } from "react";
import { MARKETPLACE_DISCLOSURE } from "@packproof/copy/errors";
import { displayName, formatDate, moneyLabel, quantityLabel } from "@packproof/copy/format";
import { providerDisplay, sourceLabel } from "@packproof/copy/status";
import type { EbaySellerOrderView, TransactionImportView, TransactionView, TransactionWriteInput } from "../api/types";
import { PageHeader } from "../components/PageHeader";

const EMPTY = {
  externalReference: "",
  transactionDate: "",
  itemTitle: "",
  itemDescription: "",
  quantity: "",
  transactionValue: "",
  currency: "",
  carrier: "",
  service: "",
  trackingNumber: "",
  shipmentDate: "",
};

type Step = "choose" | "ebay-list" | "manual" | "review" | "grading";

export function CreateProofScreen(props: {
  busy: boolean;
  error: string | null;
  development: boolean;
  ebayConnected: boolean;
  onCancel: () => void;
  onScan: () => void;
  onOpenAccount: () => void;
  onAcceptInvitation: (invitationId: string) => void;
  onCreate: (input: TransactionWriteInput) => void;
  onCreateGrading: (input: { itemCount: number; itemTitle: string }) => void;
  onImportPurchase: () => Promise<TransactionImportView>;
  onListEbayOrders: () => Promise<{ orders: EbaySellerOrderView[]; disclosure: string }>;
  onImportEbayOrder: (orderId: string) => Promise<TransactionImportView>;
  onConfirmImport: (transactionId: string) => void;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [form, setForm] = useState(EMPTY);
  const [imported, setImported] = useState<TransactionImportView | null>(null);
  const [ebayOrders, setEbayOrders] = useState<EbaySellerOrderView[]>([]);
  const [ebayDisclosure, setEbayDisclosure] = useState<string | null>(null);
  const [itemCount, setItemCount] = useState("1");
  const [gradingTitle, setGradingTitle] = useState("Grading submission");
  const [showInviteId, setShowInviteId] = useState(false);
  const [invitationId, setInvitationId] = useState("");
  const set = (key: keyof typeof EMPTY, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <main className="page">
      <PageHeader title="Create a Proof" onBack={props.onCancel} />
      {step === "choose" ? (
        <section className="section stack">
          {props.error ? (
            <div className="banner banner-error" role="alert">
              {props.error}
            </div>
          ) : null}
          <button
            className="option-card"
            type="button"
            disabled={props.busy}
            aria-label="Scan order or label"
            onClick={props.onScan}
          >
            <span className="option-icon" aria-hidden="true">
              ⌗
            </span>
            <span className="option-copy">
              <strong className="card-title">Scan order or label</strong>
              <span className="meta">Fastest</span>
            </span>
          </button>
          <button
            className="option-card"
            type="button"
            disabled={props.busy}
            aria-label="Import purchase"
            onClick={() => {
              if (props.ebayConnected) {
                void props
                  .onListEbayOrders()
                  .then((result) => {
                    setEbayOrders(result.orders);
                    setEbayDisclosure(result.disclosure);
                    setStep("ebay-list");
                  })
                  .catch(() => {
                    // Parent renders the API error.
                  });
                return;
              }
              if (!props.development) {
                props.onOpenAccount();
                return;
              }
              void props
                .onImportPurchase()
                .then((result) => {
                  setImported(result);
                  setStep("review");
                })
                .catch(() => {
                  // Parent renders the API error.
                });
            }}
          >
            <span className="option-icon" aria-hidden="true">
              ⌂
            </span>
            <span className="option-copy">
              <strong className="card-title">Import purchase</strong>
              <span className="meta">
                {props.busy
                  ? "Loading…"
                  : props.ebayConnected
                    ? "From a connected marketplace"
                    : props.development
                      ? "From a connected marketplace"
                      : "Connect a marketplace in Account first"}
              </span>
            </span>
          </button>
          <button
            className="option-card"
            type="button"
            disabled={props.busy}
            aria-label="Enter manually"
            onClick={() => setStep("manual")}
          >
            <span className="option-icon" aria-hidden="true">
              ▤
            </span>
            <span className="option-copy">
              <strong className="card-title">Enter manually</strong>
              <span className="meta">For direct sales</span>
            </span>
          </button>
          <button
            className="option-card"
            type="button"
            disabled={props.busy}
            aria-label="Grading submission"
            onClick={() => setStep("grading")}
          >
            <span className="option-icon" aria-hidden="true">
              ▣
            </span>
            <span className="option-copy">
              <strong className="card-title">Grading submission</strong>
              <span className="meta">Document items, hand off, and track receipt</span>
            </span>
          </button>
          <p className="note">
            Invite a buyer by PackProof username from the Proof after it's created. Pending invitations appear in My
            Proofs.
          </p>
          <button className="btn btn-tertiary" type="button" onClick={() => setShowInviteId((value) => !value)}>
            {showInviteId ? "Hide invitation ID" : "I have an invitation ID"}
          </button>
          {showInviteId ? (
            <div className="info-card stack">
              <p className="note">
                Use this only if you were given an invitation ID. Ordinary collaboration uses PackProof usernames.
              </p>
              <label className="field" htmlFor="create-invitation-id">
                <span>Invitation ID</span>
                <input
                  id="create-invitation-id"
                  value={invitationId}
                  onChange={(event) => setInvitationId(event.target.value)}
                  autoComplete="off"
                />
              </label>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={props.busy || !invitationId.trim()}
                onClick={() => props.onAcceptInvitation(invitationId.trim())}
              >
                Join Proof
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {step === "grading" ? (
        <section className="section stack">
          <h2>Grading submission</h2>
          <p className="lede">How many items are in this submission?</p>
          {props.error ? (
            <div className="banner banner-error" role="alert">
              {props.error}
            </div>
          ) : null}
          <label className="field">
            <span>Title</span>
            <input
              value={gradingTitle}
              onChange={(event) => setGradingTitle(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="field" htmlFor="grading-item-count">
            <span>Item count</span>
            <input
              id="grading-item-count"
              type="number"
              min={1}
              max={50}
              value={itemCount}
              onChange={(event) => setItemCount(event.target.value)}
            />
          </label>
          <div className="btn-row">
            <button
              className="btn"
              type="button"
              disabled={props.busy}
              onClick={() => {
                const count = Math.max(1, Math.min(50, Number.parseInt(itemCount, 10) || 1));
                props.onCreateGrading({
                  itemCount: count,
                  itemTitle: gradingTitle.trim() || "Grading submission",
                });
              }}
            >
              {props.busy ? "Creating…" : "Create grading Proof"}
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setStep("choose")}>
              Back
            </button>
          </div>
        </section>
      ) : null}

      {step === "review" && imported ? (
        <section className="section stack">
          <h2>Review imported purchase</h2>
          <p className="note">{MARKETPLACE_DISCLOSURE}</p>
          <ImportedFacts transaction={imported.transaction} identity={imported.identity} />
          {props.error ? (
            <div className="banner banner-error" role="alert">
              {props.error}
            </div>
          ) : null}
          <div className="btn-row">
            <button
              className="btn"
              type="button"
              disabled={props.busy}
              onClick={() => props.onConfirmImport(imported.transaction.transactionId)}
            >
              {props.busy
                ? "Opening…"
                : imported.proof?.proofId
                  ? "Open existing PackProof"
                  : "Create PackProof"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                const txn = imported.transaction;
                setForm({
                  externalReference: txn.externalReference ?? "",
                  transactionDate: txn.transactionDate ?? "",
                  itemTitle: txn.itemTitle ?? "",
                  itemDescription: txn.itemDescription ?? "",
                  quantity: txn.quantity == null ? "" : String(txn.quantity),
                  transactionValue: txn.transactionValue == null ? "" : String(txn.transactionValue),
                  currency: txn.currency ?? "",
                  carrier: txn.shipping?.carrier ?? "",
                  service: txn.shipping?.service ?? "",
                  trackingNumber: txn.shipping?.trackingNumber ?? "",
                  shipmentDate: txn.shipping?.shipmentDate ?? "",
                });
                setStep("manual");
              }}
            >
              Edit details
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setImported(null);
                setStep("choose");
              }}
            >
              Back
            </button>
          </div>
        </section>
      ) : null}

      {step === "ebay-list" ? (
        <section className="section stack">
          <h2>Your eBay sales</h2>
          {ebayDisclosure ? <p className="note">{ebayDisclosure}</p> : null}
          {props.error ? (
            <div className="banner banner-error" role="alert">
              {props.error}
            </div>
          ) : null}
          {ebayOrders.length === 0 ? (
            <p className="empty">No recent eBay sales were returned for this account.</p>
          ) : (
            ebayOrders.map((order) => (
              <button
                key={order.externalOrderId}
                className="option-card"
                type="button"
                disabled={props.busy}
                onClick={() => {
                  void props
                    .onImportEbayOrder(order.externalOrderId)
                    .then((result) => {
                      setImported(result);
                      setStep("review");
                    })
                    .catch(() => undefined);
                }}
              >
                <span className="option-copy">
                  <strong className="card-title">{order.title}</strong>
                  <span className="meta">
                    {[formatDate(order.soldAt), moneyLabel(order.total, order.currency), order.fulfillmentLabel]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {order.proofId ? (
                    <span className="meta">PackProof already exists</span>
                  ) : null}
                </span>
              </button>
            ))
          )}
          <button className="btn btn-secondary" type="button" onClick={() => setStep("choose")}>
            Back
          </button>
        </section>
      ) : null}

      {step === "manual" ? (
        <form
          className="section stack"
          onSubmit={(event) => {
            event.preventDefault();
            props.onCreate({
              externalReference: form.externalReference.trim() || null,
              transactionDate: form.transactionDate.trim() || null,
              itemTitle: form.itemTitle.trim() || null,
              itemDescription: form.itemDescription.trim() || null,
              quantity: form.quantity ? Number(form.quantity) : null,
              transactionValue: form.transactionValue ? Number(form.transactionValue) : null,
              currency: form.currency.trim() || null,
              shipping: {
                carrier: form.carrier.trim() || null,
                service: form.service.trim() || null,
                trackingNumber: form.trackingNumber.trim() || null,
                shipmentDate: form.shipmentDate.trim() || null,
              },
            });
          }}
        >
          <div className="grid-2">
            <label className="field">
              <span>Item title</span>
              <input value={form.itemTitle} onChange={(event) => set("itemTitle", event.target.value)} />
            </label>
            <label className="field">
              <span>Order reference</span>
              <input
                value={form.externalReference}
                onChange={(event) => set("externalReference", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Purchase date</span>
              <input
                value={form.transactionDate}
                onChange={(event) => set("transactionDate", event.target.value)}
                placeholder="YYYY-MM-DD"
              />
            </label>
            <label className="field">
              <span>Currency</span>
              <input value={form.currency} onChange={(event) => set("currency", event.target.value)} />
            </label>
            <label className="field">
              <span>Quantity</span>
              <input value={form.quantity} onChange={(event) => set("quantity", event.target.value)} />
            </label>
            <label className="field">
              <span>Amount</span>
              <input
                value={form.transactionValue}
                onChange={(event) => set("transactionValue", event.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>Item description</span>
            <textarea
              value={form.itemDescription}
              onChange={(event) => set("itemDescription", event.target.value)}
            />
          </label>
          <div className="grid-2">
            <label className="field">
              <span>Carrier</span>
              <input value={form.carrier} onChange={(event) => set("carrier", event.target.value)} />
            </label>
            <label className="field">
              <span>Tracking number</span>
              <input
                value={form.trackingNumber}
                onChange={(event) => set("trackingNumber", event.target.value)}
              />
            </label>
          </div>
          {props.error ? (
            <div className="banner banner-error" role="alert">
              {props.error}
            </div>
          ) : null}
          <div className="btn-row">
            <button className="btn" type="submit" disabled={props.busy}>
              {props.busy ? "Creating…" : "Create PackProof"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setForm(EMPTY);
                setStep("choose");
              }}
            >
              Back
            </button>
            <button className="btn btn-secondary" type="button" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </main>
  );
}

function ImportedFacts(props: {
  transaction: TransactionView;
  identity: TransactionImportView["identity"];
}) {
  const shipping = props.transaction.shipping;
  const provenance = props.transaction.provenance;
  const buyer = provenance?.buyer;
  const source = sourceLabel(provenance?.source ?? props.identity.source, provenance?.provider ?? props.identity.adapterKey);
  return (
    <div className="stack">
      <article className="info-card">
        <h3 className="card-title">{props.transaction.itemTitle || "Imported purchase"}</h3>
        {props.transaction.itemDescription ? <p>{props.transaction.itemDescription}</p> : null}
        <p className="meta">
          {[quantityLabel(props.transaction.quantity), moneyLabel(props.transaction.transactionValue, props.transaction.currency)]
            .filter(Boolean)
            .join(" • ")}
        </p>
        {props.transaction.transactionDate ? (
          <p className="meta">Purchased {formatDate(props.transaction.transactionDate)}</p>
        ) : null}
        {props.transaction.externalReference ? (
          <p className="meta">{props.transaction.externalReference}</p>
        ) : null}
      </article>
      <article className="info-card">
        <div className="kicker">Buyer</div>
        <p>
          {displayName({
            displayName: buyer?.displayName,
            email: buyer?.email,
            fallback: "Not provided",
          })}
        </p>
      </article>
      <article className="info-card">
        <div className="kicker">Shipping</div>
        <p>{[shipping?.carrier, shipping?.service].filter(Boolean).join(" ") || "Not provided"}</p>
        {shipping?.trackingNumber ? <p className="meta">{shipping.trackingNumber}</p> : null}
      </article>
      <p className="meta">{source}</p>
      <p className="visually-hidden">{provenance?.source ?? props.identity.source}</p>
      <p className="note">
        Recorded from {providerDisplay(provenance?.provider ?? props.identity.adapterKey) || "the connected source"}.
      </p>
    </div>
  );
}
