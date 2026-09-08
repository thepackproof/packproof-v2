import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CreateProofScreen } from "../screens/CreateProofScreen";
afterEach(cleanup);
it("requires review and preserves corrected intake provenance only for that order", async () => {
  const user = userEvent.setup(),
    create = vi.fn(),
    preview = vi.fn().mockResolvedValue({
      requiresConfirmation: true,
      warnings: ["Confirm the currency."],
      draft: {
        externalReference: "ORDER-101",
        itemTitle: "Card",
        quantity: 1,
        transactionValue: 3000,
        currency: null,
        shipping: { carrier: null, trackingNumber: "TRACK-1" },
        metadata: {
          intake: {
            source: "paste",
            sourceSha256: "abc",
            confirmed: false,
            marketplace: null,
            buyer: null,
            seller: null,
          },
        },
      },
    });
  render(
    <CreateProofScreen
      busy={false}
      error={null}
      development={true}
      ebayConnected={false}
      onCancel={() => {}}
      onScan={() => {}}
      onOpenAccount={() => {}}
      onAcceptInvitation={() => {}}
      onCreate={create}
      onPreviewIntake={preview}
      onCreateGrading={() => {}}
      onImportPurchase={vi.fn()}
      onListEbayOrders={vi.fn()}
      onImportEbayOrder={vi.fn()}
      onConfirmImport={() => {}}
    />,
  );
  await user.click(screen.getByRole("button", { name: /Paste order details/ }));
  await user.type(
    screen.getByLabelText("Order confirmation"),
    "Order: ORDER-101\nItem: Card\nPrice: $3000",
  );
  await user.click(screen.getByRole("button", { name: "Review order details" }));
  expect(await screen.findByText("Confirm the currency.")).toBeInTheDocument();
  expect(create).not.toHaveBeenCalled();
  await user.type(screen.getByLabelText("Currency"), "USD");
  await user.click(screen.getByRole("button", { name: "Open camera" }));
  await waitFor(() =>
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: "USD",
        metadata: {
          intake: expect.objectContaining({ confirmed: true, source: "paste" }),
        },
      }),
    ),
  );
  await user.click(screen.getByRole("button", {name:"Clear pasted details"}));
  await user.type(screen.getByLabelText("What are you shipping?"), "Different order");
  await user.click(screen.getByRole("button", { name: "Open camera" }));
  expect(create.mock.calls.at(-1)![0].metadata).toBeUndefined();
});
