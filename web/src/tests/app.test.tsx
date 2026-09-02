import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { isDevAuthAvailable, saveSession } from "../auth/session";
import {
  canonicalProof,
  demoConnection,
  fulfillmentItem,
  fulfillmentNext,
  invitation,
  summary,
  emptyConnectedAccounts,
} from "./fixtures";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stationReadyProof(overrides: Record<string, unknown> = {}) {
  return {
    ...canonicalProof,
    proofId: fulfillmentItem.proofId,
    transactionId: fulfillmentItem.transactionId,
    status: "READY_FOR_EVIDENCE",
    participationPolicy: "COUNTERPARTY_OPTIONAL",
    evidence: [],
    attestations: [],
    transaction: {
      ...canonicalProof.transaction,
      transactionId: fulfillmentItem.transactionId,
      externalReference: "DS-1001",
      itemTitle: "Pokémon Booster Box",
    },
    ...overrides,
  };
}

function stubStationCamera() {
  class FakeMediaRecorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    mimeType = "video/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(32)], { type: "video/webm" }) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: () => "blob:station-video",
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: () => undefined,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
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
        if (url.includes("cognito-idp")) {
          return json({
            AuthenticationResult: {
              AccessToken: "token-seller",
              RefreshToken: null,
              ExpiresIn: 3600,
            },
          });
        }
        if (url.endsWith("/auth/dev/login")) {
          return json({ userId: "user_seller", token: "token-seller" });
        }
        if (url.split("?")[0].endsWith("/me/marketplaces")) {
          return json({
            marketplaces: [
              {
                provider: "ebay",
                adapterKey: "ebay",
                enabled: false,
                environment: "sandbox",
                connection: null,
              },
            ],
          });
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
        if (url.endsWith("/me/connected-accounts")) {
          return json(emptyConnectedAccounts);
        }
        if (url.includes("/integration-connections")) {
          return json({ connections: [] });
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
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  it("renders the privacy policy without a PackProof session", async () => {
    window.history.replaceState(null, "", "/new/privacy");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
    expect(screen.getAllByText(/does not sell personal data/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Last updated September 1, 2026/)).toBeInTheDocument();
  });

  it("renders terms of service from a direct URL without signing in", async () => {
    window.history.replaceState(null, "", "/new/terms");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Terms of Service" })).toBeInTheDocument();
    expect(screen.getAllByText(/not an adjudicator/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  });

  it("links privacy, terms, and PackProof from the unauthenticated legal layout", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/new/privacy");
    render(<App />);
    await screen.findByRole("heading", { name: "Privacy Policy" });
    await user.click(screen.getByRole("link", { name: "Terms of Service" }));
    expect(await screen.findByRole("heading", { name: "Terms of Service" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/new/terms");
    await user.click(screen.getByRole("link", { name: "Privacy Policy" }));
    expect(await screen.findByRole("heading", { name: "Privacy Policy" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("link", { name: "Back to PackProof" })[0]);
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
  });

  it("shows privacy and terms links on the sign-in screen", async () => {
    render(<App />);
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/new/privacy");
    expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/new/terms");
  });

  it("does not treat /new/privacy as the create flow for a signed-in user", async () => {
    signInSession();
    window.history.replaceState(null, "", "/new/privacy");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Privacy Policy" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
  });

  it("lets an authenticated user load Proof discovery summaries", async () => {
    signInSession();
    render(<App />);
    expect(await screen.findByRole("heading", { name: "My Proofs" })).toBeInTheDocument();
    expect((await screen.findAllByText("Vintage camera")).length).toBeGreaterThan(0);
    expect(screen.getByText("Invitation received")).toBeInTheDocument();
    expect(screen.getByText(/UPS/)).toBeInTheDocument();
    expect(screen.queryByText("PackProof fact")).not.toBeInTheDocument();
  });

  it("fetches the canonical Proof when a summary is selected", async () => {
    signInSession();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Vintage camera\. Packing evidence needed/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Vintage camera" })).toBeInTheDocument();
    });
    expect(screen.getAllByText("PackProof fact").length).toBeGreaterThan(0);
    expect(screen.getAllByText("User attestation").length).toBeGreaterThan(0);
    expect(screen.getAllByText("External data").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Vintage camera").length).toBeGreaterThan(0);
    expect(screen.getByText("I packed the described item.")).toBeInTheDocument();
    expect(
      screen.getByText(/Participant statement recorded by PackProof/),
    ).toBeInTheDocument();
    expect(screen.getByText("8af291d4deadbeefcafebabef00d000011112222333344445555666677778888"))
      .toBeInTheDocument();
    const history = screen.getByRole("heading", { name: "Proof record" }).closest("section");
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
    expect(screen.getByRole("heading", { name: "Vintage camera" })).toBeInTheDocument();
  });

  it("accepts an invitation ID and then loads the canonical Proof", async () => {
    signInSession();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Create a new Proof" }));
    await user.click(screen.getByRole("button", { name: "I have an invitation ID" }));
    await user.type(await screen.findByLabelText("Invitation ID"), "inv_01");
    await user.click(screen.getByRole("button", { name: "Join Proof" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Vintage camera" })).toBeInTheDocument();
    });
    expect(screen.queryByText("secret-token")).not.toBeInTheDocument();
  });

  it("reviews a pending invitation before joining the Proof", async () => {
    signInSession();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Vintage camera\. Invitation received/i }));
    expect(await screen.findByRole("heading", { name: /been added to a PackProof/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review Proof" })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/invitations/inv_01/accept"),
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: "Review Proof" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Vintage camera" })).toBeInTheDocument();
    });
    expect(screen.queryByText("secret-token")).not.toBeInTheDocument();
  });

  it("identifies an order from Create Scan and opens the Proof", async () => {
    signInSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/me/packing-station/resolve") && init?.method === "POST") {
          return json({
            schema: "packproof.packing-station.resolve/v1",
            reference: "ORD-48392",
            matchedBy: "EXTERNAL_ORDER_ID",
            transactionId: summary.transactionId,
            proofId: summary.proofId,
            proofStatus: "READY_FOR_EVIDENCE",
            participationPolicy: "COUNTERPARTY_REQUIRED",
            orderLabel: "Order #ORD-48392",
            itemSummary: "Vintage camera",
            committedEvidenceCount: 0,
            captureReady: true,
            alreadyFinalized: false,
            alreadyHasCommittedEvidence: false,
            blockReason: null,
          });
        }
        if (url.endsWith(`/transactions/${summary.transactionId}/proof`) && init?.method === "POST") {
          return json(canonicalProof);
        }
        if (url.includes("/shipment-integrity")) {
          return json({ status: "CORE_NOT_FINALIZED", verification: { valid: false } });
        }
        if (url.endsWith(`/proofs/${summary.proofId}`)) {
          return json(canonicalProof);
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        if (url.split("?")[0].endsWith("/me/marketplaces")) {
          return json({ marketplaces: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Create a new Proof" }));
    await user.click(await screen.findByRole("button", { name: "Scan order or label" }));
    expect(await screen.findByRole("heading", { name: "Scan order" })).toBeInTheDocument();
    expect(screen.queryByText("READY")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Reference"), "ORD-48392");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Order found" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open existing Proof" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Vintage camera" })).toBeInTheDocument();
    });
  });

  it("can sign in through the PackProof account form", async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.queryByLabelText("Development subject")).not.toBeInTheDocument();
    if (isDevAuthAvailable()) {
      await user.click(screen.getByText("Developer options"));
      await user.click(screen.getByLabelText("Use development subject"));
      await user.clear(screen.getByLabelText("Development subject"));
      await user.type(screen.getByLabelText("Development subject"), "seller-1");
    } else {
      await user.type(screen.getByLabelText("Email"), "seller@example.com");
      await user.type(screen.getByLabelText("Password"), "SecretPass1");
    }
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getAllByText("Vintage camera").length).toBeGreaterThan(0);
    });
  });

  it("reviews a server-imported purchase before creating the Proof", async () => {
    signInSession();
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Create a new Proof" }));
    expect(await screen.findByRole("button", { name: "Import purchase" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enter manually" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import purchase" }));
    expect(await screen.findByRole("heading", { name: "Review imported purchase" })).toBeInTheDocument();
    expect(screen.getByText("Vintage film camera")).toBeInTheDocument();
    expect(screen.getByText("DM-WEB-1")).toBeInTheDocument();
    expect(screen.getByText("Alex Buyer")).toBeInTheDocument();
    expect(screen.getByText("MARKETPLACE_API")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create PackProof" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Vintage camera" })).toBeInTheDocument();
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

  it("sends marketplace import from Create and does not offer Connect eBay there", async () => {
    signInSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.split("?")[0].endsWith("/me/marketplaces")) {
          return json({
            marketplaces: [
              {
                provider: "ebay",
                adapterKey: "ebay",
                enabled: true,
                environment: "sandbox",
                connection: null,
              },
            ],
          });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Create a new Proof" }));
    expect(await screen.findByRole("button", { name: "Import purchase" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect eBay" })).not.toBeInTheDocument();
    expect(screen.queryByText("Vintage film camera")).not.toBeInTheDocument();
  });

  it("lists connected eBay sales instead of the demo marketplace import", async () => {
    signInSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const path = url.split("?")[0];
        if (path.endsWith("/me/marketplaces")) {
          return json({
            marketplaces: [
              {
                provider: "ebay",
                adapterKey: "ebay",
                enabled: true,
                environment: "sandbox",
                connection: {
                  connectionId: "icn_ebay",
                  status: "ACTIVE",
                  displayName: "collin_seller",
                  connectedAt: "2026-09-01T12:00:00.000Z",
                  updatedAt: "2026-09-01T12:05:00.000Z",
                },
              },
            ],
          });
        }
        if (path.endsWith("/me/marketplaces/ebay/orders")) {
          return json({
            role: "SELLING",
            connection: { connectionId: "icn_ebay", status: "ACTIVE", displayName: "collin_seller" },
            orders: [
              {
                externalOrderId: "12-00007-84931",
                title: "Nikon F3 Camera",
                soldAt: "2026-08-31T18:12:00.000Z",
                total: 349.99,
                currency: "USD",
                fulfillmentStatus: "NOT_STARTED",
                fulfillmentLabel: "Ready to ship",
                buyerUsername: "buyer_one",
                quantity: 1,
                proofId: null,
                transactionId: null,
              },
            ],
            disclosure:
              "Transaction information was supplied by eBay. PackProof records the supplied information but does not independently verify the listing contents or transaction claims.",
          });
        }
        if (path.endsWith("/me/marketplaces/ebay/orders/12-00007-84931/import") && init?.method === "POST") {
          return json({
            created: true,
            identity: {
              adapterKey: "ebay",
              tenantKey: "marketplace:ebay:sandbox",
              externalTransactionId: "12-00007-84931",
              source: "MARKETPLACE_API",
            },
            proof: null,
            transaction: {
              ...canonicalProof.transaction,
              transactionId: "txn_ebay",
              proofId: null,
              proofStatus: null,
              itemTitle: "Nikon F3 Camera",
              externalReference: "12-00007-84931",
              provenance: {
                source: "MARKETPLACE_API",
                adapterKey: "ebay",
                provider: "ebay",
                tenantKey: "marketplace:ebay:sandbox",
                externalTransactionId: "12-00007-84931",
                sourceRecordId: "12-00007-84931",
                importedAt: "2026-09-01T12:06:00.000Z",
                payloadSha256: "aa".repeat(32),
                buyer: { externalId: "buyer_one", displayName: "buyer_one", email: null },
              },
            },
          });
        }
        if (path.endsWith("/transactions/txn_ebay/proof")) {
          return json({
            ...canonicalProof,
            transactionId: "txn_ebay",
            transaction: {
              ...canonicalProof.transaction,
              transactionId: "txn_ebay",
              itemTitle: "Nikon F3 Camera",
              externalReference: "12-00007-84931",
            },
          });
        }
        if (url.includes("/shipment-integrity")) {
          return json({
            schema: "packproof.shipment.integrity/v1",
            status: "CORE_NOT_FINALIZED",
            proofId: canonicalProof.proofId,
            transactionId: "txn_ebay",
            shippingId: null,
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
        if (url.includes(`/proofs/${canonicalProof.proofId}`) && !url.includes("/attestations")) {
          return json({
            ...canonicalProof,
            transactionId: "txn_ebay",
            transaction: {
              ...canonicalProof.transaction,
              transactionId: "txn_ebay",
              itemTitle: "Nikon F3 Camera",
              externalReference: "12-00007-84931",
            },
          });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        if (url.includes("/integration-connections")) {
          return json({ connections: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Create a new Proof" }));
    await user.click(await screen.findByRole("button", { name: "Import purchase" }));
    expect(await screen.findByRole("heading", { name: "Your eBay sales" })).toBeInTheDocument();
    expect(screen.getByText("Nikon F3 Camera")).toBeInTheDocument();
    expect(screen.getByText(/Ready to ship/)).toBeInTheDocument();
    expect(screen.queryByText("Vintage film camera")).not.toBeInTheDocument();
    expect(screen.queryByText("Alex Buyer")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Nikon F3 Camera/ }));
    expect(await screen.findByRole("heading", { name: "Review imported purchase" })).toBeInTheDocument();
    expect(screen.getByText("Nikon F3 Camera")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create PackProof" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Proof record" })).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "Nikon F3 Camera" })).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some((call) => String(call[0]).includes("/integrations/transactions/import"))).toBe(
      false,
    );
    expect(
      vi.mocked(fetch).mock.calls.some((call) =>
        String(call[0]).includes("/me/marketplaces/ebay/orders/12-00007-84931/import"),
      ),
    ).toBe(true);
  });

  it("shows an eBay connection error after OAuth return", async () => {
    signInSession();
    window.history.replaceState(null, "", "/stores?ebay=error&code=EBAY_OAUTH_FAILED");
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t connect eBay/i);
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
    await user.click(await screen.findByRole("button", { name: "Proof actions" }));
    await user.click(screen.getByRole("button", { name: "Add buyer" }));
    const search = screen.getByLabelText("Search PackProof username");
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
    expect(screen.getAllByText("You").length).toBeGreaterThan(0);
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

  it("renders the fulfillment queue and a multi-item packing workspace", async () => {
    signInSession();
    let attested = false;
    let finalized = false;
    const multi = {
      ...fulfillmentItem,
      items: [
        ...fulfillmentItem.items,
        {
          itemId: "itm_extra",
          externalItemId: "line-1001-2",
          position: 2,
          title: "Sleeve pack",
          description: null,
          sku: null,
          quantity: 2,
          unitValue: 6,
          currency: "USD",
        },
      ],
      itemSummary: "Pokémon Booster Box + 1 more",
      itemCount: 2,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/me/fulfillment-queue")) {
          const item = attested
            ? { ...multi, sellerPackingAttested: true, canComplete: false, fulfillmentCaptureCount: 0 }
            : multi;
          if (finalized && url.includes("filter=ready")) {
            return json({ items: [fulfillmentNext], filter: "ready" });
          }
          return json({ items: finalized ? [fulfillmentNext] : [item, fulfillmentNext], filter: "all" });
        }
        if (url.includes("/me/packing-station/resolve") && init?.method === "POST") {
          return json({
            schema: "packproof.packing-station.resolve/v1",
            reference: "DS-1001",
            matchedBy: "EXTERNAL_ORDER_ID",
            transactionId: multi.transactionId,
            proofId: multi.proofId,
            proofStatus: "READY_FOR_EVIDENCE",
            participationPolicy: "COUNTERPARTY_OPTIONAL",
            orderLabel: "Order #DS-1001",
            itemSummary: "Pokémon Booster Box + 1 more",
            trackingHint: null,
            committedEvidenceCount: 0,
            captureReady: true,
            alreadyFinalized: false,
            alreadyHasCommittedEvidence: false,
            blockReason: null,
          });
        }
        if (url.endsWith(`/transactions/${multi.transactionId}/proof`)) {
          return json({
            ...canonicalProof,
            proofId: multi.proofId,
            transactionId: multi.transactionId,
            status: "READY_FOR_EVIDENCE",
            participationPolicy: "COUNTERPARTY_OPTIONAL",
            evidence: [],
            transaction: {
              ...canonicalProof.transaction,
              transactionId: multi.transactionId,
              externalReference: "DS-1001",
              itemTitle: "Pokémon Booster Box",
            },
          });
        }
        if (url.includes("/attestations") && init?.method === "POST") {
          attested = true;
          return json({
            attestation: { attestationId: "att_1", statement: "PACKED_DESCRIBED_ITEM" },
            proof: canonicalProof,
          });
        }
        if (url.includes("/finalize") && init?.method === "POST") {
          finalized = true;
          return json({
            proof: { ...canonicalProof, status: "FINALIZED" },
            manifest: { manifestId: "man_1", proofId: multi.proofId, sha256: "aa", canonicalJson: "{}", manifest: {} },
          });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Account" }));
    await user.click(await screen.findByRole("button", { name: "Fulfillment" }));
    expect(await screen.findByRole("heading", { name: "Fulfillment" })).toBeInTheDocument();
    expect(screen.getByText("Order #DS-1001")).toBeInTheDocument();
    expect(screen.getByText("Pokémon Booster Box + 1 more")).toBeInTheDocument();
    expect(screen.getAllByText(/Demo Storefront/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/video is required/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/buyer acceptance/i)).not.toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Pack" })[0]);
    expect(await screen.findByRole("heading", { name: "Order #DS-1001" })).toBeInTheDocument();
    expect(screen.getByText("Sleeve pack")).toBeInTheDocument();
    expect(screen.getByText(/Buyer acceptance is not required/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Packing Station" })).toBeInTheDocument();
    expect(screen.getByText(/Packing evidence is required/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete PackProof" })).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I attest that I packed this order as described/i }));
    expect(await screen.findByText("Packing attestation recorded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete & Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open Packing Station" }));
    expect(await screen.findByText("READY TO PACK")).toBeInTheDocument();
    expect(screen.getByText("Order #DS-1001")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Packing" })).toBeInTheDocument();
  });

  it("connects and syncs the demo storefront from Connected Stores", async () => {
    signInSession();
    let connected = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/dev/integrations/demo-storefront/connect") && init?.method === "POST") {
          connected = true;
          return json({ connection: demoConnection }, 201);
        }
        if (url.split("?")[0].endsWith("/me/marketplaces")) {
          return json({
            marketplaces: [
              {
                provider: "ebay",
                adapterKey: "ebay",
                enabled: true,
                environment: "sandbox",
                connection: null,
              },
            ],
          });
        }
        if (url.includes("/me/integration-connections")) {
          return json({ connections: connected ? [{ ...demoConnection, readyOrderCount: 6 }] : [] });
        }
        if (url.includes("/commerce-connections/") && url.endsWith("/sync")) {
          return json({
            connectionId: "icn_demo",
            adapterKey: "demo-storefront",
            provider: "demo-storefront",
            discoveredCount: 10,
            eligibleCount: 6,
            createdTransactionCount: 6,
            createdProofCount: 6,
            existingProofCount: 0,
            ineligibleCount: 4,
            cursor: null,
          });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Account" }));
    await user.click(await screen.findByRole("button", { name: "Connected stores" }));
    expect(await screen.findByRole("heading", { name: "Connected Stores" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Connect eBay" })).toBeInTheDocument();
    expect(screen.queryByText(/Connect Shopify/i)).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Connect Demo Storefront" }));
    expect(await screen.findByText("Demo Store")).toBeInTheDocument();
    expect(screen.getByText(/6 orders ready/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(/10 orders discovered/)).toBeInTheDocument();
    expect(screen.queryByText(/icn_/)).not.toBeInTheDocument();
  });

  it("connects Google from Account without sending client secrets", async () => {
    signInSession();
    const assign = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      assign,
      href: "http://localhost/",
      origin: "http://localhost",
      pathname: "/",
      search: "",
      hash: "",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/me/connected-accounts") && init?.method !== "POST") {
          return json(emptyConnectedAccounts);
        }
        if (url.endsWith("/me/connected-accounts/google/connect") && init?.method === "POST") {
          return json(
            {
              authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=public&state=abc",
              expiresAt: "2026-09-02T15:00:00.000Z",
              provider: "google",
            },
            201,
          );
        }
        if (url.split("?")[0].endsWith("/me/marketplaces")) {
          return json({ marketplaces: [] });
        }
        if (url.includes("/integration-connections")) {
          return json({ connections: [] });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Account" }));
    expect(await screen.findByRole("heading", { name: "Connected Accounts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Google" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Meta" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect Shopify" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Connect Google" }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        "/me/connected-accounts/google/connect",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(JSON.stringify(vi.mocked(fetch).mock.calls)).not.toContain("secret");
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id=public&state=abc",
      );
    });
  });

  it("identifies an imported order in Packing Station and recovers from a bad reference", async () => {
    signInSession();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/me/fulfillment-queue")) {
          return json({ items: [fulfillmentItem, fulfillmentNext], filter: "ready" });
        }
        if (url.includes("/me/packing-station/resolve") && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as { reference?: string };
          if (body.reference?.toUpperCase() === "DS-1001" || body.reference === "#DS-1001") {
            return json({
              schema: "packproof.packing-station.resolve/v1",
              reference: "DS-1001",
              matchedBy: "EXTERNAL_ORDER_ID",
              transactionId: fulfillmentItem.transactionId,
              proofId: fulfillmentItem.proofId,
              proofStatus: "READY_FOR_EVIDENCE",
              participationPolicy: "COUNTERPARTY_OPTIONAL",
              orderLabel: "Order #DS-1001",
              itemSummary: "Pokémon Booster Box",
              committedEvidenceCount: 0,
              captureReady: true,
              alreadyFinalized: false,
              alreadyHasCommittedEvidence: false,
              blockReason: null,
            });
          }
          return json({ error: { code: "STATION_REFERENCE_NOT_FOUND", message: "No packing order matched that reference" } }, 404);
        }
        if (url.endsWith(`/transactions/${fulfillmentItem.transactionId}/proof`)) {
          return json({
            ...canonicalProof,
            proofId: fulfillmentItem.proofId,
            transactionId: fulfillmentItem.transactionId,
            status: "READY_FOR_EVIDENCE",
            participationPolicy: "COUNTERPARTY_OPTIONAL",
            evidence: [],
            transaction: {
              ...canonicalProof.transaction,
              transactionId: fulfillmentItem.transactionId,
              externalReference: "DS-1001",
              itemTitle: "Pokémon Booster Box",
            },
          });
        }
        if (url.endsWith(`/transactions/${fulfillmentNext.transactionId}/proof`)) {
          return json({
            ...canonicalProof,
            proofId: fulfillmentNext.proofId,
            transactionId: fulfillmentNext.transactionId,
            status: "READY_FOR_EVIDENCE",
            participationPolicy: "COUNTERPARTY_OPTIONAL",
            evidence: [],
            transaction: {
              ...canonicalProof.transaction,
              transactionId: fulfillmentNext.transactionId,
              externalReference: "DS-1002",
              itemTitle: "Vintage Watch",
            },
          });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/station");
    render(<App />);
    expect(await screen.findByText("READY")).toBeInTheDocument();
    expect(screen.getByText(/Scan a label/)).toBeInTheDocument();
    expect(screen.queryByText(/SHA-256|manifest|object store/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Scan Order / Label" }));
    expect(await screen.findByText("SCAN")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Scan or enter barcode"), "NOPE");
    await user.click(screen.getByRole("button", { name: "Use this code" }));
    expect(await screen.findByText("No packing order matched that reference")).toBeInTheDocument();
    expect(screen.getByText("NEEDS ATTENTION")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ready for next order" }));
    expect(await screen.findByText("READY")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Order #DS-1001/ }));
    expect(await screen.findByText("READY TO PACK")).toBeInTheDocument();
    expect(screen.getByText("Order #DS-1001")).toBeInTheDocument();
    expect(screen.getByText("Pokémon Booster Box")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Packing" })).toBeInTheDocument();
  });

  it("finishes a webcam pack by USB rescan of the same order and keeps recording on a wrong barcode", async () => {
    signInSession();
    stubStationCamera();
    let proofCreates = 0;
    let uploadInits = 0;
    let packed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/me/fulfillment-queue")) {
          return json({ items: [fulfillmentItem, fulfillmentNext], filter: "ready" });
        }
        if (url.includes("/me/packing-station/resolve") && init?.method === "POST") {
          const body = JSON.parse(String(init.body ?? "{}")) as { reference?: string };
          if (body.reference === "DS-1002") {
            return json({
              schema: "packproof.packing-station.resolve/v1",
              reference: "DS-1002",
              matchedBy: "EXTERNAL_ORDER_ID",
              transactionId: fulfillmentNext.transactionId,
              proofId: fulfillmentNext.proofId,
              proofStatus: "READY_FOR_EVIDENCE",
              participationPolicy: "COUNTERPARTY_OPTIONAL",
              orderLabel: "Order #DS-1002",
              itemSummary: "Vintage Watch",
              committedEvidenceCount: 0,
              captureReady: true,
              alreadyFinalized: false,
              alreadyHasCommittedEvidence: false,
              blockReason: null,
            });
          }
          if (body.reference === "DS-1001" || body.reference === "9400111899223344556677") {
            return json({
              schema: "packproof.packing-station.resolve/v1",
              reference: body.reference,
              matchedBy: body.reference === "DS-1001" ? "EXTERNAL_ORDER_ID" : "TRACKING_NUMBER",
              transactionId: fulfillmentItem.transactionId,
              proofId: fulfillmentItem.proofId,
              proofStatus: "READY_FOR_EVIDENCE",
              participationPolicy: "COUNTERPARTY_OPTIONAL",
              orderLabel: "Order #DS-1001",
              itemSummary: "Pokémon Booster Box",
              committedEvidenceCount: 0,
              captureReady: true,
              alreadyFinalized: false,
              alreadyHasCommittedEvidence: false,
              blockReason: null,
            });
          }
          return json({ error: { code: "STATION_REFERENCE_NOT_FOUND", message: "No packing order matched that reference" } }, 404);
        }
        if (url.endsWith(`/transactions/${fulfillmentItem.transactionId}/proof`)) {
          proofCreates += 1;
          return json(stationReadyProof());
        }
        if (url.endsWith(`/proofs/${fulfillmentItem.proofId}/evidence/uploads`) && init?.method === "POST") {
          uploadInits += 1;
          const body = JSON.parse(String(init.body ?? "{}")) as { evidenceType?: string };
          expect(body.evidenceType).toBe("FULFILLMENT_CAPTURE");
          return json({
            evidenceId: "evd_station",
            proofId: fulfillmentItem.proofId,
            objectKey: "obj_station",
            contentType: "video/webm",
            evidenceType: "FULFILLMENT_CAPTURE",
            validationStatus: "PENDING_UPLOAD",
            upload: { method: "PUT", url: "/upload/t", headers: {} },
          });
        }
        if (url.includes("/upload/")) {
          return new Response(null, { status: 200 });
        }
        if (url.includes(`/proofs/${fulfillmentItem.proofId}/evidence/evd_station/commit`)) {
          return json({
            proof: stationReadyProof({
              status: "EVIDENCE_COMMITTED",
              evidence: [{ validationStatus: "COMMITTED", evidenceType: "FULFILLMENT_CAPTURE" }],
            }),
            sha256: "aa",
            evidenceId: "evd_station",
          });
        }
        if (url.includes("/attestations") && init?.method === "POST") {
          return json({
            attestation: { attestationId: "att_station", statement: "PACKED_DESCRIBED_ITEM" },
            proof: stationReadyProof({
              status: "EVIDENCE_COMMITTED",
              evidence: [{ validationStatus: "COMMITTED", evidenceType: "FULFILLMENT_CAPTURE" }],
              attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "user_seller" }],
            }),
          });
        }
        if (url.includes("/finalize") && init?.method === "POST") {
          packed = true;
          return json({
            proof: stationReadyProof({
              status: "FINALIZED",
              evidence: [{ validationStatus: "COMMITTED", evidenceType: "FULFILLMENT_CAPTURE" }],
              attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "user_seller" }],
            }),
            manifest: { manifestId: "man_station", proofId: fulfillmentItem.proofId, sha256: "aa", canonicalJson: "{}", manifest: {} },
          });
        }
        if (url.endsWith(`/proofs/${fulfillmentItem.proofId}`)) {
          return json(
            packed
              ? stationReadyProof({
                  status: "FINALIZED",
                  evidence: [{ validationStatus: "COMMITTED", evidenceType: "FULFILLMENT_CAPTURE" }],
                  attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "user_seller" }],
                })
              : stationReadyProof(),
          );
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/station");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Order #DS-1001/ }));
    expect(await screen.findByText("READY TO PACK")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Packing" }));
    expect(await screen.findByText("RECORDING")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scan Package to Finish" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finished Packing" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Scan Package to Finish" }));
    expect(await screen.findByText("SCAN TO FINISH")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Scan or enter barcode"), "DS-1002");
    await user.click(screen.getByRole("button", { name: "Use this code" }));
    expect(await screen.findByText("Different order scanned. Finish packing the current order first.")).toBeInTheDocument();
    expect(screen.getByText("RECORDING")).toBeInTheDocument();
    expect(screen.getByText("Order #DS-1001")).toBeInTheDocument();
    expect(proofCreates).toBe(1);

    await user.click(screen.getByRole("button", { name: "Scan Package to Finish" }));
    await user.type(screen.getByPlaceholderText("Scan or enter barcode"), "9400111899223344556677");
    await user.click(screen.getByRole("button", { name: "Use this code" }));
    expect(await screen.findByText("PROOF CREATED")).toBeInTheDocument();
    expect(proofCreates).toBe(1);
    expect(uploadInits).toBe(1);
    expect(await screen.findByText("READY", {}, { timeout: 4000 })).toBeInTheDocument();
  });

  it("keeps Finished Packing as a secondary webcam fallback", async () => {
    signInSession();
    stubStationCamera();
    let packed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/me/fulfillment-queue")) {
          return json({ items: [fulfillmentItem], filter: "ready" });
        }
        if (url.endsWith(`/transactions/${fulfillmentItem.transactionId}/proof`)) {
          return json(stationReadyProof());
        }
        if (url.endsWith(`/proofs/${fulfillmentItem.proofId}/evidence/uploads`) && init?.method === "POST") {
          return json({
            evidenceId: "evd_manual",
            proofId: fulfillmentItem.proofId,
            objectKey: "obj_manual",
            contentType: "video/webm",
            evidenceType: "FULFILLMENT_CAPTURE",
            validationStatus: "PENDING_UPLOAD",
            upload: { method: "PUT", url: "/upload/t", headers: {} },
          });
        }
        if (url.includes("/upload/")) {
          return new Response(null, { status: 200 });
        }
        if (url.includes("/commit")) {
          return json({
            proof: stationReadyProof({
              status: "EVIDENCE_COMMITTED",
              evidence: [{ validationStatus: "COMMITTED", evidenceType: "FULFILLMENT_CAPTURE" }],
            }),
            sha256: "aa",
            evidenceId: "evd_manual",
          });
        }
        if (url.includes("/attestations") && init?.method === "POST") {
          return json({
            attestation: { attestationId: "att_manual", statement: "PACKED_DESCRIBED_ITEM" },
            proof: stationReadyProof({
              status: "EVIDENCE_COMMITTED",
              evidence: [{ validationStatus: "COMMITTED", evidenceType: "FULFILLMENT_CAPTURE" }],
              attestations: [{ statement: "PACKED_DESCRIBED_ITEM", attestedBy: "user_seller" }],
            }),
          });
        }
        if (url.includes("/finalize") && init?.method === "POST") {
          packed = true;
          return json({
            proof: stationReadyProof({ status: "FINALIZED" }),
            manifest: { manifestId: "man_manual", proofId: fulfillmentItem.proofId, sha256: "aa", canonicalJson: "{}", manifest: {} },
          });
        }
        if (url.endsWith(`/proofs/${fulfillmentItem.proofId}`)) {
          return json(packed ? stationReadyProof({ status: "FINALIZED" }) : stationReadyProof());
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/station");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: /Order #DS-1001/ }));
    await user.click(await screen.findByRole("button", { name: "Start Packing" }));
    expect(await screen.findByRole("button", { name: "Scan Package to Finish" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finished Packing" }));
    expect(await screen.findByText("PROOF CREATED")).toBeInTheDocument();
  });

  it("renders a guest viewing page without a session", async () => {
    window.history.replaceState(null, "", "/p/guest-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/public/proofs/guest-token")) {
          return json({
            schema: "packproof.proof.public/v1",
            proofId: "proof_public",
            status: "EVIDENCE_COMMITTED",
            workflowType: "GRADING_SUBMISSION",
            workflowStage: "IN_TRANSIT",
            nextAction: { type: "WAIT_FOR_RECEIPT", title: "Waiting for receipt", hint: "No PackProof observation exists for this interval yet." },
            scope: "SUMMARY",
            join: {
              eligible: true,
              requiresAuthentication: true,
              message: "Sign in to join this Proof as a participant.",
            },
            observations: [{ label: "Handed off", occurredAt: "2026-09-01T12:00:00.000Z" }],
          });
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    render(<App />);
    expect(await screen.findByRole("heading", { name: "View Proof" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for receipt")).toBeInTheDocument();
    expect(screen.getAllByText("Handed off").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Join PackProof" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      "/public/proofs/guest-token",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates a grading submission from Create", async () => {
    signInSession();
    const gradingProof = {
      ...canonicalProof,
      proofId: "proof_grading",
      workflowType: "GRADING_SUBMISSION",
      nextAction: {
        type: "CAPTURE_ASSET",
        title: "Document item 1 of 2",
        hint: "Capture the front and back of this item.",
        captureRecipe: "CARD_STANDARD_V1",
      },
      assets: [
        { assetId: "asset_1", assetInstanceId: "inst_1", assetType: "CARD", label: "Item 1", labelIndex: 1 },
        { assetId: "asset_2", assetInstanceId: "inst_2", assetType: "CARD", label: "Item 2", labelIndex: 2 },
      ],
      transaction: { ...canonicalProof.transaction, itemTitle: "Grading submission" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        if (url.split("?")[0].endsWith("/me/marketplaces")) {
          return json({ marketplaces: [] });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        if (url.includes("/integration-connections")) {
          return json({ connections: [] });
        }
        if (url.endsWith("/proofs") && init?.method === "POST") {
          expect(JSON.parse(String(init.body ?? "{}"))).toEqual({
            workflowType: "GRADING_SUBMISSION",
            itemCount: 2,
            itemTitle: "Grading submission",
          });
          return json(gradingProof, 201);
        }
        if (url.includes("/proofs/proof_grading")) {
          return json(gradingProof);
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Create a new Proof" }));
    await user.click(await screen.findByRole("button", { name: "Grading submission" }));
    await user.clear(screen.getByLabelText("Item count"));
    await user.type(screen.getByLabelText("Item count"), "2");
    await user.click(screen.getByRole("button", { name: "Create grading Proof" }));
    expect(await screen.findByText("Document item 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Item 1")).toBeInTheDocument();
    expect(screen.getByText("You are the Originator")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Proof actions" }));
    expect(screen.getByRole("button", { name: "Add receiving participant" })).toBeInTheDocument();
  });

  it("shows origin and receipt captures side by side", async () => {
    signInSession();
    const comparedProof = {
      ...canonicalProof,
      proofId: "proof_compare",
      workflowType: "GRADING_SUBMISSION",
      nextAction: { type: "RETURN_PACK", title: "Document return packing", hint: "Record the return packing." },
      transaction: { ...canonicalProof.transaction, itemTitle: "Grading submission" },
      evidence: [
        { evidenceId: "evd_o_f", evidenceType: "ASSET_CAPTURE", validationStatus: "COMMITTED", sha256: "aa", byteSize: 12, committedAt: "2026-09-02T12:00:00.000Z", contentType: "image/jpeg" },
        { evidenceId: "evd_r_f", evidenceType: "RECEIPT_CAPTURE", validationStatus: "COMMITTED", sha256: "bb", byteSize: 12, committedAt: "2026-09-02T12:01:00.000Z", contentType: "image/jpeg" },
        { evidenceId: "evd_o_b", evidenceType: "ASSET_CAPTURE", validationStatus: "COMMITTED", sha256: "cc", byteSize: 12, committedAt: "2026-09-02T12:00:00.000Z", contentType: "image/jpeg" },
        { evidenceId: "evd_r_b", evidenceType: "RECEIPT_CAPTURE", validationStatus: "COMMITTED", sha256: "dd", byteSize: 12, committedAt: "2026-09-02T12:01:00.000Z", contentType: "image/jpeg" },
      ],
      continuityObservations: [
        {
          evaluationId: "cmp_1",
          result: "CONSISTENT",
          summary: "The available observations are materially consistent.",
          algorithmVersion: "visual-slot-completeness/v1",
          evidencePairs: [
            { slot: "FRONT", originEvidenceId: "evd_o_f", receivedEvidenceId: "evd_r_f" },
            { slot: "BACK", originEvidenceId: "evd_o_b", receivedEvidenceId: "evd_r_b" },
          ],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
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
        if (url.split("?")[0].endsWith("/me/marketplaces")) {
          return json({ marketplaces: [] });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        if (url.includes("/integration-connections")) {
          return json({ connections: [] });
        }
        if (url.includes("/users/search")) {
          return json({ users: [] });
        }
        if (url.includes("/shipment-integrity")) {
          return json({
            schema: "packproof.shipment.integrity/v1",
            status: "CORE_NOT_FINALIZED",
            proofId: "proof_compare",
            transactionId: "txn_01",
            shippingId: null,
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
        if (url.includes("/proofs/proof_compare/evidence/")) {
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "Content-Type": "image/jpeg" },
          });
        }
        if (url.includes("/proofs/proof_compare")) {
          return json(comparedProof);
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    window.history.replaceState(null, "", "/proofs/proof_compare");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Before sending versus when received" })).toBeInTheDocument();
    expect(screen.getByText("Consistent")).toBeInTheDocument();
    expect(screen.getByText("The available observations are materially consistent.")).toBeInTheDocument();
    expect(screen.getByText("Front")).toBeInTheDocument();
    expect(screen.getByText("Back")).toBeInTheDocument();
    expect(screen.getAllByText("Before sending").length).toBe(2);
    expect(screen.getAllByText("When received").length).toBe(2);
    expect(await screen.findAllByRole("img", { name: "Before sending" })).toHaveLength(2);
  });

  it("copies a viewing link from the Proof page", async () => {
    signInSession();
    window.history.replaceState(null, "", "/proofs/proof_01ABCVERYLONGIDENTIFIERVALUE");
    const writeText = vi.fn(async () => undefined);
    if (navigator.clipboard) {
      vi.spyOn(navigator.clipboard, "writeText").mockImplementation(writeText);
    } else {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
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
        if (url.split("?")[0].endsWith("/me/marketplaces")) {
          return json({ marketplaces: [] });
        }
        if (url.endsWith("/me/proofs")) {
          return json({ proofs: [summary] });
        }
        if (url.endsWith("/invitations")) {
          return json({ invitations: [] });
        }
        if (url.includes("/integration-connections")) {
          return json({ connections: [] });
        }
        if (url.includes("/users/search")) {
          return json({ users: [] });
        }
        if (url.includes("/shipment-integrity")) {
          return json({
            schema: "packproof.shipment.integrity/v1",
            status: "CORE_NOT_FINALIZED",
            proofId: canonicalProof.proofId,
            transactionId: canonicalProof.transactionId,
            shippingId: null,
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
        if (url.endsWith(`/proofs/${canonicalProof.proofId}/access-links`) && init?.method === "POST") {
          return json(
            {
              accessLinkId: "link_1",
              proofId: canonicalProof.proofId,
              scope: "SUMMARY",
              url: "https://app.packproof.test/p/shared-token",
              token: "shared-token",
              createdAt: "2026-09-02T12:00:00.000Z",
              expiresAt: null,
              revokedAt: null,
            },
            201,
          );
        }
        if (url.includes(`/proofs/${canonicalProof.proofId}`)) {
          return json(canonicalProof);
        }
        return json({ error: { code: "NOT_FOUND", message: "missing" } }, 404);
      }),
    );
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Proof actions" }));
    await user.click(await screen.findByRole("button", { name: "Share viewing link" }));
    await waitFor(() => {
      expect(screen.getByText(/Viewing link copied/)).toBeInTheDocument();
    });
    const shareCall = vi.mocked(fetch).mock.calls.find((call) =>
      String(call[0]).includes("/access-links"),
    );
    expect(shareCall?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    if (writeText.mock.calls.length > 0) {
      expect(writeText).toHaveBeenCalledWith("https://app.packproof.test/p/shared-token");
    }
  });
});
