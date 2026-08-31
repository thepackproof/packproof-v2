import { useState } from "react";
import type { TransactionImportView, TransactionView, TransactionWriteInput } from "../api/types";
import { displayValue } from "../format";

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

type Step = "choose" | "manual" | "review";

export function CreateProofScreen(props: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (input: TransactionWriteInput) => void;
  onImportPurchase: () => Promise<TransactionImportView>;
  onConfirmImport: (transactionId: string) => void;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [form, setForm] = useState(EMPTY);
  const [imported, setImported] = useState<TransactionImportView | null>(null);
  const set = (key: keyof typeof EMPTY, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <main className="page">
      <h1>Create Proof</h1>
      <p className="lede">
        Creates a transaction, then asks the server for the one Proof bound to it. Display fields
        are external metadata. They are not independently verified facts.
      </p>

      {step === "choose" ? (
        <section className="section stack">
          <p>Import a reference marketplace purchase, or enter the transaction yourself.</p>
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
              onClick={() => {
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
              {props.busy ? "Importing…" : "Import purchase"}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={props.busy}
              onClick={() => setStep("manual")}
            >
              Enter manually
            </button>
            <button className="btn btn-secondary" type="button" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {step === "review" && imported ? (
        <section className="section stack">
          <h2>Review imported purchase</h2>
          <p className="note">
            These details came from the server after the reference import. Confirm them to create
            the Proof. PackProof recorded them; it did not independently verify the order.
          </p>
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
              {props.busy ? "Creating…" : "Use imported purchase"}
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
              <span>External reference</span>
              <input
                value={form.externalReference}
                onChange={(event) => set("externalReference", event.target.value)}
              />
            </label>
            <label className="field">
              <span>Transaction date</span>
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
              <span>Transaction value</span>
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
              {props.busy ? "Creating…" : "Create Proof"}
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
  const rows: Array<[string, unknown]> = [
    ["Item", props.transaction.itemTitle],
    ["Description", props.transaction.itemDescription],
    ["Transaction/order reference", props.transaction.externalReference],
    ["Purchase date", props.transaction.transactionDate],
    ["Quantity", props.transaction.quantity],
    [
      "Value",
      props.transaction.transactionValue == null
        ? null
        : `${props.transaction.transactionValue} ${props.transaction.currency ?? ""}`.trim(),
    ],
    ["Buyer", buyer?.displayName ?? buyer?.email ?? buyer?.externalId],
    ["Carrier", shipping?.carrier],
    ["Shipping service", shipping?.service],
    ["Tracking number", shipping?.trackingNumber],
    ["Shipment date", shipping?.shipmentDate],
    ["Source", provenance?.source],
    ["Provider", provenance?.provider ?? props.identity.adapterKey],
  ];
  return (
    <dl className="dl">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{displayValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}
