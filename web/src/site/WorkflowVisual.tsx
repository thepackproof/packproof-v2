import { Glyph } from "./Brand";

export type WorkflowVisualKind = "details" | "recording" | "history" | "collection" | "recipient";

const descriptions: Record<WorkflowVisualKind, string> = {
  details: "An order record brings item and transaction details together, with connected-store import available.",
  recording: "A capture viewfinder and chapter rail show the item, packing, and seal in one recording.",
  history: "A chronological record runs from creation through recording to finalization and export.",
  collection: "A workspace groups order details, packing evidence, and activity in an organized record.",
  recipient: "A recipient sees a read-only view containing the selected order summary and evidence.",
};

/** Explanatory UI schematics, not live controls or customer records. */
export function WorkflowVisual({ kind }: { kind: WorkflowVisualKind }) {
  return <div className={`workflow-visual workflow-visual--${kind}`} role="img" aria-label={descriptions[kind]}>
    <div className="workflow-visual-content" aria-hidden="true">
      {kind === "details" && <div className="visual-order-sheet">
        <div className="visual-order-heading"><Glyph name="file" size={38} /><span>ORDER<br /><strong>Details first.</strong></span></div>
        <div className="visual-order-field"><span>Item</span><span className="visual-field-line" /></div>
        <div className="visual-order-field"><span>Transaction</span><span className="visual-field-line" /></div>
        <div className="visual-import"><Glyph name="download" size={18} /><span>Import from your store</span></div>
      </div>}
      {kind === "recording" && <div className="visual-recording">
        <div className="visual-viewfinder"><span className="visual-recording-label"><i /> CAPTURE</span><Glyph name="expand" size={64} /><span className="visual-viewfinder-note">Keep the details in frame</span></div>
        <div className="visual-chapters">{["Item", "Packing", "Seal"].map(label => <span key={label}><i />{label}</span>)}</div>
        <span className="visual-recording-caption">ONE CONTINUOUS RECORDING</span>
      </div>}
      {kind === "history" && <div className="visual-history">
        <div className="visual-history-heading"><Glyph name="clock" size={30} /><span>THE SHIPMENT STORY</span></div>
        <div className="visual-history-entries">{[
          ["Created", "Order details added"], ["Recorded", "Packing documented"], ["Finalized", "Record preserved"],
        ].map(([title, detail]) => <div className="visual-history-entry" key={title}><span className="visual-history-node" /><span><strong>{title}</strong><small>{detail}</small></span></div>)}</div>
        <div className="visual-history-footer"><Glyph name="download" size={17} /> Ready to export</div>
      </div>}
      {kind === "collection" && <div className="visual-collection">
        <div className="visual-collection-heading"><Glyph name="grid" size={30} /><span>YOUR WORKSPACE</span></div>
        <div className="visual-collection-index"><span>One organized record</span><Glyph name="menu" size={16} /></div>
        {[["file", "Order details"], ["film", "Packing evidence"], ["activity", "Activity"]].map(([icon, label]) => <div className="visual-collection-row" key={label}><Glyph name={icon} size={19} /><span>{label}</span><span className="visual-collection-mark" /></div>)}
      </div>}
      {kind === "recipient" && <div className="visual-recipient">
        <div className="visual-recipient-toolbar"><Glyph name="panel" size={18} /><span>RECIPIENT VIEW</span></div>
        <div className="visual-recipient-access"><span className="visual-recipient-person"><Glyph name="settings" size={30} /></span><span><strong>Ready to review</strong><small>Read-only access</small></span></div>
        <div className="visual-recipient-field"><Glyph name="check" size={16} /> Order summary</div>
        <div className="visual-recipient-field"><Glyph name="check" size={16} /> Selected evidence</div>
        <div className="visual-recipient-footer">You choose what to share.</div>
      </div>}
    </div>
  </div>;
}
