import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PackProofApi } from "../api/client";
import { SubmissionIntakePanel } from "../components/SubmissionIntakePanel";

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);
const saved = { submissionId: "submission_one", clientSubmissionId: "unused", state: "READY", proofId: "proof_one", transactionId: "transaction_one", nextAction: "RECORD_PACKING", retryable: false, errorCode: null, updatedAt: "2026-09-15T00:00:00Z", message: "Your order is ready.", candidates: [] };
function panel(handler: (path: string, method?: string, body?: unknown) => Promise<unknown>) {
  const api = { recoveryScope: "https://api.example", intakeRequest: vi.fn(handler) } as unknown as PackProofApi;
  const onOpenProof = vi.fn();
  return { api, onOpenProof, props: { api, userId: "seller_one", onPreview: vi.fn(), onReview: vi.fn(), onOpenProof } };
}

it("keeps one submission identity across network retries and opens only a server-resolved order on user action", async () => {
  let attempts = 0;
  const { api, props, onOpenProof } = panel(async (path) => {
    if (path === "/capabilities") return { submissionEnabled: true };
    if (++attempts === 1) throw new Error("Connection interrupted. Try again.");
    return saved;
  });
  render(<SubmissionIntakePanel {...props} />);
  await userEvent.type(await screen.findByLabelText("Order text or link"), "private order text");
  await userEvent.click(screen.getByRole("button", { name: "Find order" }));
  await screen.findByRole("alert");
  await userEvent.click(screen.getByRole("button", { name: "Find order" }));
  await screen.findByText("Your order is ready.");
  const calls = vi.mocked(api.intakeRequest).mock.calls.filter(row => row[0] === "/submissions");
  expect(calls).toHaveLength(2);
  expect(calls[0][2]).toEqual(calls[1][2]);
  expect(calls[0][2]).toMatchObject({ surface: "EXPLICIT_PASTE", payload: { kind: "TEXT", text: "private order text" } });
  expect(onOpenProof).not.toHaveBeenCalled();
  expect(JSON.stringify(sessionStorage)).not.toContain("private order text");
  await userEvent.click(screen.getByRole("button", { name: "Open order" }));
  expect(onOpenProof).toHaveBeenCalledWith("proof_one");
});

it("restores only the current account's opaque receipt even when new intake is paused", async () => {
  sessionStorage.setItem("packproof.intake-receipt:https://api.example:another_seller", "other_receipt");
  sessionStorage.setItem("packproof.intake-receipt:https://api.example:seller_one", "submission_one");
  const { api, props } = panel(async path => path === "/capabilities" ? { submissionEnabled: false } : saved);
  render(<SubmissionIntakePanel {...props} />);
  await screen.findByText("Your order is ready.");
  expect(api.intakeRequest).toHaveBeenCalledWith("/submissions/submission_one");
  expect(vi.mocked(api.intakeRequest).mock.calls.some(row => row[0].includes("other_receipt") || row[1] === "POST")).toBe(false);
});

it("requires explicit candidate selection and only sends its server-issued locator", async () => {
  const { api, props } = panel(async path => path === "/capabilities" ? { submissionEnabled: true } : path.endsWith("/resolve") ? saved : { ...saved, state: "NEEDS_SELECTION", proofId: null, message: "Choose your order.", candidates: [{ candidateId: "candidate_safe", orderReference: "ORDER-1", itemSummary: "Collectible", provider: "ebay", transactionId: "transaction_one" }] });
  render(<SubmissionIntakePanel {...props} />);
  await userEvent.type(await screen.findByLabelText("Order text or link"), "listing");
  await userEvent.click(screen.getByRole("button", { name: "Find order" }));
  await userEvent.click(await screen.findByRole("button", { name: "ORDER-1 · Collectible" }));
  await waitFor(() => expect(api.intakeRequest).toHaveBeenCalledWith("/submissions/submission_one/resolve", "POST", { candidateId: "candidate_safe" }));
});

it("requires seller confirmation of manual fulfillment facts before creating the saved order", async () => {
  const { api, props } = panel(async path => path === "/capabilities" ? { submissionEnabled: true } : path.endsWith("/resolve") ? saved : { ...saved, state: "NEEDS_SELECTION", proofId: null, transactionId: null, message: "Check your shared details.", candidates: [] });
  render(<SubmissionIntakePanel {...props} />);
  await userEvent.type(await screen.findByLabelText("Order text or link"), "unrecognized input");
  await userEvent.click(screen.getByRole("button", { name: "Find order" }));
  await userEvent.click(await screen.findByRole("button", { name: "Enter order details manually" }));
  await userEvent.type(screen.getByLabelText("What are you shipping?"), "Collectible");
  expect(screen.getByRole("button", { name: "Confirm order details" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox"));
  await userEvent.click(screen.getByRole("button", { name: "Confirm order details" }));
  await waitFor(() => expect(api.intakeRequest).toHaveBeenCalledWith("/submissions/submission_one/resolve", "POST", { confirmed: true, details: { itemTitle: "Collectible", physicalFulfillment: true, paid: true, fulfillmentScope: "FULL_ORDER" } }));
  expect(props.onOpenProof).not.toHaveBeenCalled();
});
