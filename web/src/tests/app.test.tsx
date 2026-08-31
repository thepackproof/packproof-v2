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
        if (url.includes("/users/search")) {
          return json({ users: [] });
        }
        if (url.includes("/shipment-integrity")) {
          return json({
            schema: "packproof.shipment.integrity/v1",
            status: "CORE_NOT_FINALIZED",
            proofId: "proof_01ABCVERYLONGIDENTIFIERVALUE",
            transactionId: "txn_01",
            shippingId: "shp_1",
            coreManifestSha256: null,
            shipmentSupplementSha256: null,
            eventCount: 0,
            firstEventSha256: null,
            latestEventSha256: null,
            supplement: null,
            verification: {
              coreManifestValid: false,
              eventContentHashesValid: true,
              eventChainValid: true,
              supplementValid: false,
              linkedToFinalizedProof: false,
              valid: false,
            },
          });
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

  it("renders server shipment integrity on a finalized Proof", async () => {
    signInSession();
    window.history.replaceState(null, "", "/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/shipment-integrity")) {
          return json({
            schema: "packproof.shipment.integrity/v1",
            status: "LINKED",
            algorithm: "SHA-256",
            proofId: canonicalProof.proofId,
            transactionId: canonicalProof.transactionId,
            shippingId: "shp_1",
            coreManifestSha256: "cc".repeat(32),
            shipmentSupplementSha256: "dd".repeat(32),
            eventCount: 2,
            firstEventSha256: "ee".repeat(32),
            latestEventSha256: "ff".repeat(32),
            supplement: {
              schema: "packproof.shipment.supplement/v1",
              proofId: canonicalProof.proofId,
              transactionId: canonicalProof.transactionId,
              coreManifestSha256: "cc".repeat(32),
              shipment: {
                shippingId: "shp_1",
                carrier: "UPS",
                service: "Ground",
                trackingNumber: "1Z999",
                shipmentDate: "2026-08-21",
              },
              events: [
                { shipmentEventId: "sev_1", sha256: "ee".repeat(32) },
                { shipmentEventId: "sev_2", sha256: "ff".repeat(32) },
              ],
            },
            verification: {
              coreManifestValid: true,
              eventContentHashesValid: true,
              eventChainValid: true,
              supplementValid: true,
              linkedToFinalizedProof: true,
              valid: true,
            },
          });
        }
        if (url.includes("/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE")) {
          return json({
            ...canonicalProof,
            status: "FINALIZED",
            finalizedAt: "2026-08-30T12:20:00.000Z",
            transaction: { ...canonicalProof.transaction, proofStatus: "FINALIZED" },
          });
        }
        if (url.endsWith("/me")) {
          return json({
            userId: "user_seller",
            username: "seller",
            displayName: "Seller",
            status: "ACTIVE",
            createdAt: "2026-08-30T12:00:00.000Z",
            updatedAt: "2026-08-30T12:00:00.000Z",
          });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Shipment record" })).toBeInTheDocument();
    expect(screen.getByText("2 shipment observations")).toBeInTheDocument();
    expect(screen.getByText("✓ Linked to finalized PackProof")).toBeInTheDocument();
    expect(screen.getByText("✓ Shipment event chain valid")).toBeInTheDocument();
    expect(screen.getByText("dd".repeat(32))).toBeInTheDocument();
    expect(
      screen.getByText(/does not verify that a carrier’s real-world statement is true/),
    ).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE/shipment-integrity",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("searches PackProof users and invites by user id without showing tokens", async () => {
    signInSession();
    window.history.replaceState(null, "", "/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE");
    const searchUsers = [
      {
        userId: "user_buyer",
        username: "janesmith",
        displayName: "Jane Smith",
        invitationState: "NONE",
      },
      {
        userId: "user_seller",
        username: "seller",
        displayName: "Seller",
        invitationState: "SELF",
      },
      {
        userId: "user_joined",
        username: "joineduser",
        displayName: "Already Here",
        invitationState: "PARTICIPANT",
      },
      {
        userId: "user_pending",
        username: "pendinguser",
        displayName: "Waiter",
        invitationState: "INVITED",
      },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/users/search")) {
        return json({ users: searchUsers });
      }
      if (url.includes("/invitations") && method === "POST") {
        expect(init?.body).toBe(JSON.stringify({ inviteeUserId: "user_buyer" }));
        return json(
          {
            invitation: {
              invitationId: "inv_created",
              proofId: canonicalProof.proofId,
              inviteeUserId: "user_buyer",
              status: "PENDING",
              token: "raw-invite-token",
            },
            proof: {
              ...canonicalProof,
              invitations: [
                {
                  invitationId: "inv_created",
                  inviteeIdentifier: "user:user_buyer",
                  inviteeUserId: "user_buyer",
                  status: "PENDING",
                  createdAt: "2026-08-31T12:00:00.000Z",
                  acceptedAt: null,
                  expiresAt: null,
                },
              ],
            },
          },
          201,
        );
      }
      if (url.includes("/shipment-integrity")) {
        return json({ status: "CORE_NOT_FINALIZED", verification: { valid: false } });
      }
      if (url.includes("/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE")) {
        return json(canonicalProof);
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
      return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Add participant" }));
    const search = screen.getByLabelText("Search by username or name");
    expect(search).toBeInTheDocument();
    await user.type(search, "a");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/users/search")),
    ).toBe(false);
    await user.clear(search);
    await user.type(search, "buyer");
    await waitFor(() => {
      expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    });
    expect(screen.getByText("@janesmith")).toBeInTheDocument();
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Already participating")).toBeInTheDocument();
    expect(screen.getByText("Invitation pending")).toBeInTheDocument();
    expect(screen.queryByText("alex.buyer@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("raw-invite-token")).not.toBeInTheDocument();
    expect(screen.queryByText(/Invite token/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => {
      expect(screen.getAllByText("Invitation pending").length).toBeGreaterThan(0);
    });
    const inviteCall = fetchMock.mock.calls.find(
      (call) => String(call[0]).includes("/invitations") && call[1]?.method === "POST",
    );
    expect(inviteCall?.[0]).toBe(
      "/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE/invitations",
    );
    expect(inviteCall?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ inviteeUserId: "user_buyer" }),
      }),
    );
    expect(screen.queryByText("raw-invite-token")).not.toBeInTheDocument();
    expect(JSON.stringify(inviteCall?.[1]?.body ?? "")).not.toContain("email");
  });
});
