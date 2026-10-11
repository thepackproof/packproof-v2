import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { previewOrderIntake } from "../src/intake/order-intake.js";

describe("bounded order text extraction", () => {
  it("preserves plain text and ordinary HTML facts, confirmation and original-source identity", () => {
    const facts = ["Order: A-123", "Item: Card & Sleeve", "Qty: 2", "Total: USD 3,000.00", "Buyer: Alex", "Tracking: 1Z123", "Carrier: UPS"];
    const plain = previewOrderIntake({ text: facts.join("\r\n"), source: "email" });
    const html = '<div data-label="not > a tag">Order: A-123</div><p>Item:&nbsp;Card &amp; Sleeve</p><p>Qty: 2</p><p>Total: USD 3,000.00</p><p>Buyer: Alex</p><p>Tracking: 1Z123</p><p>Carrier: UPS</p>';
    const parsed = previewOrderIntake({ text: html, source: "email" });
    expect(parsed.draft).toEqual({ ...plain.draft, metadata: { intake: { ...plain.draft.metadata.intake,
      sourceSha256: createHash("sha256").update(html).digest("hex") } } });
    expect(parsed.requiresConfirmation).toBe(true);
    expect(parsed.draft.metadata.intake.confirmed).toBe(false);
    expect(parsed.warnings).toEqual(plain.warnings);
  });

  it("ignores scripts and styles with mixed case, malformed closing attributes and quoted tag characters", () => {
    for (const tag of ["script", "style", "ScRiPt", "STYLE"]) {
      for (const close of [`</${tag} >`, `</${tag} ignored="value">`, `</${tag}/>`, `</${tag}>`]) {
        const text = `<${tag} data-note=">">\nOrder: WRONG\nItem: WRONG\nQty: 999\n${close}<p>Order: RIGHT</p><p>Item: Card</p>`;
        const result = previewOrderIntake({ text });
        expect(result.draft.externalReference).toBe("RIGHT");
        expect(result.draft.itemTitle).toBe("Card");
        expect(result.draft.quantity).toBeNull();
      }
    }
  });

  it("does not reinterpret removed markup, comments, raw-text content or templates as order facts", () => {
    for (const hidden of [
      '<script><script>\nItem: WRONG\n</script>',
      '<style><style>\nItem: WRONG\n</style>',
      '<!--\nItem: WRONG\n--!>',
      '<template><p>Item: WRONG</p></template>',
      '<svg><script>\nItem: WRONG\n</script><style>\nItem: WRONG\n</style></svg>',
    ]) {
      const result = previewOrderIntake({ text: hidden + '<p>Item: Card</p><p>Order: RIGHT</p>' });
      expect(result.draft.itemTitle).toBe("Card");
      expect(result.draft.externalReference).toBe("RIGHT");
    }
    for (const tag of ["script", "style"])
      expect(previewOrderIntake({ text: `<${tag}>\nItem: WRONG\nOrder: WRONG` }).draft.itemTitle).toBeNull();
  });

  it("keeps encoded markup as literal text without a second parse or execution", () => {
    const result = previewOrderIntake({ text: '<p>Item: Card &lt;script&gt;literal&lt;/script&gt; &#38; Sleeve</p>' });
    expect(result.draft.itemTitle).toBe("Card <script>literal</script> & Sleeve");
    expect(result.draft.metadata.intake.confirmed).toBe(false);
  });

  it("handles deep/malformed bounded fragments and rejects oversized input before parsing", () => {
    const deep = "<div>".repeat(1500) + "Item: Card" + "</div>".repeat(1500);
    expect(previewOrderIntake({ text: deep }).draft.itemTitle).toBe("Card");
    expect(() => previewOrderIntake({ text: "<".repeat(20000) })).not.toThrow();
    expect(() => previewOrderIntake({ text: "<".repeat(20001) })).toThrow("Paste between 1 and 20,000 characters");
  });
});
