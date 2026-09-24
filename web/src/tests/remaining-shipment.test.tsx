import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { WorkspaceProofRecord } from "../components/WorkspaceProofRecord";
import { SharedProofRecord, type SharedProofView } from "../components/SharedProofRecord";
import { hasRemainingShipmentScope, REMAINING_SHIPMENT_EXPLANATION } from "@packproof/copy/fulfillment-scope";
import { canonicalProof } from "./fixtures";

afterEach(cleanup);

it("keeps the immutable remaining-shipment limitation visible on the participant record", () => {
  const proof = { ...canonicalProof, transaction: { ...canonicalProof.transaction, metadata: { import: {
    provider: "shopify", providerIdentifiers: { fulfillmentScope: "REMAINING_SHIPMENT" },
  } } } };
  render(<WorkspaceProofRecord proof={proof} currentUserId="user_seller" />);
  expect(screen.getByText("Remaining shipment")).toBeVisible();
  expect(screen.getByText(REMAINING_SHIPMENT_EXPLANATION)).toBeVisible();
});

it("shows only the server-authorized public scope and does not infer it for other links", () => {
  const proof: SharedProofView = { proofId: "shared_remaining", status: "FINALIZED", workflowType: "COMMERCE_SALE",
    workflowStage: "PACKING", nextAction: null, scope: "PUBLIC", fulfillmentScope: "REMAINING_SHIPMENT",
    join: { eligible: false, requiresAuthentication: true, message: "" } };
  const { rerender } = render(<SharedProofRecord proof={proof} />);
  expect(screen.getByText("Remaining shipment")).toBeVisible();
  expect(screen.getByText(REMAINING_SHIPMENT_EXPLANATION)).toBeVisible();
  rerender(<SharedProofRecord proof={{ ...proof, fulfillmentScope: undefined }} />);
  expect(screen.queryByText("Remaining shipment")).not.toBeInTheDocument();
});

it("uses an explicit order snapshot marker and ignores descriptive text or a partial status", () => {
  expect(hasRemainingShipmentScope({ orderContext: { snapshot: { fulfillmentScope: "REMAINING_SHIPMENT" } } })).toBe(true);
  expect(hasRemainingShipmentScope({ fulfillmentScope: "PARTIAL", transaction: { itemDescription: "Remaining shipment" } })).toBe(false);
  expect(hasRemainingShipmentScope(null)).toBe(false);
});
