import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { saveSession } from "../auth/session";
import { canonicalProof, invitation, summary } from "./fixtures";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function signInSession() {
  saveSession({
    apiBaseUrl: "",
    authMode: "dev",
    userId: "user_seller",
    username: "seller",
    displayName: "Seller",
    token: "token-seller",
    refreshToken: null,
    accessExpiresAt: null,
    subject: "seller-1",
  });
}

describe("PackProof web reference client", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    sessionStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/auth/dev/login")) {
          return json({ userId: "user_seller", token: "token-seller" });
        }
        if (url.endsWith("/me") && !url.includes("/proofs")) {
          return json({
            userId: "user_seller",
            username: "seller",
            displayName: "Seller",
            status: "ACTIVE",
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [invitation] });
        }
        if (url.includes("/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE") && !url.includes("/attestations")) {
          return json(canonicalProof);
        }
        if (url.includes("/proofs/forbidden")) {
          return json({ error: { code: "PARTICIPANT_NOT_AUTHORIZED", message: "secret title" } }, 403);
        }
        if (url.includes("/invitations/inv_01/accept")) {
          return json({
            invitation: { invitationId: "inv_01", proofId: summary.proofId, token: "secret-token" },
            proof: canonicalProof,
          });
        }
        if (url.endsWith("/integrations/transactions/import")) {
          return json({
            created: true,
            identity: {
              adapterKey: "demo-marketplace",
              tenantKey: "marketplace:demo-marketplace",
              externalTransactionId: "DM-WEB-1",
              source: "MARKETPLACE_API",
            },
            proof: null,
            transaction: {
              ...canonicalProof.transaction,
              transactionId: "txn_imported",
              proofId: null,
              proofStatus: null,
              itemTitle: "Vintage film camera",
              externalReference: "DM-WEB-1",
              provenance: {
                source: "MARKETPLACE_API",
                adapterKey: "demo-marketplace",
                provider: "demo-marketplace",
                tenantKey: "marketplace:demo-marketplace",
                externalTransactionId: "DM-WEB-1",
                sourceRecordId: "demo-order-DM-WEB-1",
                importedAt: "2026-08-31T15:00:00.000Z",
                payloadSha256: "aa".repeat(32),
                buyer: { externalId: "buyer_demo_1", displayName: "Alex Buyer", email: "alex.buyer@example.com" },
              },
            },
          });
        }
        if (url.endsWith("/transactions/txn_imported/proof")) {
          return json({
            ...canonicalProof,
            transactionId: "txn_imported",
            transaction: { ...canonicalProof.transaction, transactionId: "txn_imported" },
          });
        }
        if (url.endsWith("/me/proofs-fail")) {
          return json({ error: { code: "INTERNAL", message: "down" } }, 500);
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("lets an authenticated user load Proof discovery summaries", async () => {
    signInSession();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Proofs" })).toBeInTheDocument();
    expect(screen.getAllByText("Vintage camera").length).toBeGreaterThan(0);
    expect(screen.getByText(/Reference ORD-48392/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pending invitations" })).toBeInTheDocument();
    expect(screen.queryByText("PackProof fact")).not.toBeInTheDocument();
  });

  it("fetches the canonical Proof when a summary is selected", async () => {
    signInSession();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Open Proof" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Proof record" })).toBeInTheDocument();
    });
    expect(screen.getAllByText("PackProof fact").length).toBeGreaterThan(0);
    expect(screen.getAllByText("User attestation").length).toBeGreaterThan(0);
    expect(screen.getAllByText("External data").length).toBeGreaterThan(0);
    expect(screen.getByText("Vintage camera")).toBeInTheDocument();
    expect(screen.getByText("I packed the described item.")).toBeInTheDocument();
    expect(
      screen.getByText(/Participant statement recorded by PackProof/),
    ).toBeInTheDocument();
    expect(screen.getByText("8af291d4deadbeefcafebabef00d000011112222333344445555666677778888"))
      .toBeInTheDocument();
    const history = screen.getByRole("heading", { name: "Chronology" }).closest("section");
    expect(history).toBeTruthy();
    const events = within(history as HTMLElement).getAllByRole("listitem");
    expect(events[0]).toHaveTextContent("Proof created");
    expect(events[1]).toHaveTextContent("Participant joined");
    expect(events[2]).toHaveTextContent("Packing evidence committed");
    expect(fetch).toHaveBeenCalledWith(
      "/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("does not leak Proof contents on unauthorized access", async () => {
    signInSession();
    window.history.replaceState(null, "", "/proofs/forbidden");
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This Proof is not available.");
    expect(screen.queryByText("secret title")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Proof record" })).not.toBeInTheDocument();
  });

  it("returns the user to sign-in after an expired session", async () => {
    signInSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401),
      ),
    );
    render(<App />);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText("Vintage camera")).not.toBeInTheDocument();
  });

  it("shows an empty discovery state", async () => {
    signInSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    render(<App />);
    expect(await screen.findByText(/No Proofs to show yet/)).toBeInTheDocument();
  });

  it("shows an API failure on discovery", async () => {
    signInSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ error: { code: "INTERNAL", message: "API unavailable" } }, 500)),
    );
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("API unavailable");
  });

  it("keeps long digests inspectable on a narrow viewport", async () => {
    signInSession();
    window.history.replaceState(null, "", "/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    render(<App />);
    const digest = await screen.findByText(
      "8af291d4deadbeefcafebabef00d000011112222333344445555666677778888",
    );
    expect(digest.className).toContain("digest");
    expect(screen.getByRole("heading", { name: "Proof record" })).toBeInTheDocument();
  });

  it("accepts an invitation ID and then loads the canonical Proof", async () => {
    signInSession();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("heading", { name: "Proofs" });
    await user.type(screen.getByLabelText("Invitation ID"), "inv_01");
    await user.click(screen.getAllByRole("button", { name: "Accept invitation" })[1]);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Proof record" })).toBeInTheDocument();
    });
    expect(screen.queryByText("secret-token")).not.toBeInTheDocument();
  });

  it("can sign in through the development subject flow", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.clear(screen.getByLabelText("Development subject"));
    await user.type(screen.getByLabelText("Development subject"), "seller-1");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Proofs" })).toBeInTheDocument();
    });
  });

  it("reviews a server-imported purchase before creating the Proof", async () => {
    signInSession();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Create Proof" }));
    expect(await screen.findByRole("button", { name: "Import purchase" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter manually" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import purchase" }));
    expect(await screen.findByRole("heading", { name: "Review imported purchase" })).toBeInTheDocument();
    expect(screen.getByText("Vintage film camera")).toBeInTheDocument();
    expect(screen.getByText("DM-WEB-1")).toBeInTheDocument();
    expect(screen.getByText("Alex Buyer")).toBeInTheDocument();
    expect(screen.getByText("MARKETPLACE_API")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use imported purchase" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Proof record" })).toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith(
      "/integrations/transactions/import",
      expect.objectContaining({ method: "POST" }),
    );
    const importCall = vi.mocked(fetch).mock.calls.find((call) =>
      String(call[0]).endsWith("/integrations/transactions/import"),
    );
    expect(importCall?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({
          adapterKey: "demo-marketplace",
          mode: "reference",
          externalTransactionId: null,
          createProof: false,
        }),
      }),
    );
    expect(String(importCall?.[1] && "body" in importCall[1] ? importCall[1].body : "")).not.toContain(
      "ebay_order_id",
    );
  });
});
