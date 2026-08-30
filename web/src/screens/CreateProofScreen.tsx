import { useState } from "react";
import type { TransactionWriteInput } from "../api/types";

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

export function CreateProofScreen(props: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (input: TransactionWriteInput) => void;
}) {
  const [form, setForm] = useState(EMPTY);
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
          <button className="btn btn-secondary" type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </main>
  );
}
