import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUserFacingError, toUserFacingError } from "@packproof/copy/errors";
import { captureEvidenceType } from "@packproof/copy/custody";
import { PackProofApi } from "./api/client";
import { ApiError } from "./api/types";
import type {
  CanonicalProof,
  CommerceConnectionView,
  CommerceSyncView,
  ConnectedAccountProviderCatalogView,
  ConnectedAccountView,
  EbayMarketplaceView,
  FulfillmentQueueItem,
  InvitationInboxView,
  ProofCollectionItem,
  ShipmentIntegrityView,
  TransactionWriteInput,
} from "./api/types";
import { clearSession, isProfileComplete, loadSession, saveSession, type WebSession } from "./auth/session";
import { AppNav } from "./components/AppNav";
import { ThemeProvider } from "./theme/ThemeProvider";
import { AccountScreen } from "./screens/AccountScreen";
import { ActivityScreen } from "./screens/ActivityScreen";
import { ConnectedStoresScreen } from "./screens/ConnectedStoresScreen";
import { CreateProofScreen } from "./screens/CreateProofScreen";
import { FulfillmentDetailScreen } from "./screens/FulfillmentDetailScreen";
import { FulfillmentQueueScreen } from "./screens/FulfillmentQueueScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { PackingStationScreen } from "./screens/PackingStationScreen";
import { ProofScreen } from "./screens/ProofScreen";
import { PublicProofScreen } from "./screens/PublicProofScreen";
import { LegalScreen } from "./screens/LegalScreen";
import { ProfileSetupScreen } from "./screens/ProfileSetupScreen";
import { SignInScreen } from "./screens/SignInScreen";

type Route =
  | { name: "home" }
  | { name: "proofs" }
  | { name: "create" }
  | { name: "activity" }
  | { name: "account" }
  | { name: "proof"; proofId: string }
  | { name: "fulfillment" }
  | { name: "fulfillment-detail"; proofId: string }
  | { name: "station"; reference?: string }
  | { name: "stores" }
  | { name: "privacy" }
  | { name: "terms" }
  | { name: "public"; token: string };

function parseHref(href: string): Route {
  const url = new URL(href, "http://packproof.local");
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (pathname === "/new/privacy") {
    return { name: "privacy" };
  }
  if (pathname === "/new/terms") {
    return { name: "terms" };
  }
  if (pathname === "/new") {
    return { name: "create" };
  }
  if (pathname === "/proofs") {
    return { name: "proofs" };
  }
  if (pathname === "/activity") {
    return { name: "activity" };
  }
  if (pathname === "/account") {
    return { name: "account" };
  }
  if (pathname === "/fulfillment") {
    return { name: "fulfillment" };
  }
  if (pathname === "/station") {
    const reference = url.searchParams.get("reference")?.trim() || undefined;
    return { name: "station", reference };
  }
  if (pathname === "/stores") {
    return { name: "stores" };
  }
  const shared = pathname.match(/^\/p\/([^/]+)$/);
  if (shared?.[1]) {
    return { name: "public", token: decodeURIComponent(shared[1]) };
  }
  const fulfillment = pathname.match(/^\/fulfillment\/([^/]+)$/);
  if (fulfillment?.[1]) {
    return { name: "fulfillment-detail", proofId: decodeURIComponent(fulfillment[1]) };
  }
  const proof = pathname.match(/^\/proofs\/([^/]+)$/);
  if (proof?.[1]) {
    return { name: "proof", proofId: decodeURIComponent(proof[1]) };
  }
  return { name: "home" };
}

function writePath(path: string) {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current !== path) {
    window.history.pushState(null, "", path);
  }
}

function pickEbay(listed: { marketplaces: EbayMarketplaceView[] }): EbayMarketplaceView | null {
  return listed.marketplaces.find((item) => item.provider === "ebay") ?? null;
}

function oauthReturnError(href: string): string | null {
  const url = new URL(href, "http://packproof.local");
  if (url.searchParams.get("ebay") === "declined") {
    return "eBay authorization was declined.";
  }
  const failed =
    url.searchParams.get("connected") === "error" || url.searchParams.get("ebay") === "error";
  if (!failed) {
    return null;
  }
  return formatUserFacingError({
    code: url.searchParams.get("code") || "CONNECTED_ACCOUNT_AUTH_ERROR",
    message: "Connection failed",
  });
}

function oauthReturnNotice(href: string): string | null {
  const url = new URL(href, "http://packproof.local");
  const connected = url.searchParams.get("connected");
  if (connected && connected !== "error") {
    const provider = url.searchParams.get("provider") || connected;
    return `${providerDisplayName(provider)} is connected.`;
  }
  if (url.searchParams.get("ebay") === "connected") {
    return "eBay is connected.";
  }
  return null;
}

function providerDisplayName(provider: string): string {
  switch (provider.toLowerCase()) {
    case "ebay":
      return "eBay";
    case "shopify":
      return "Shopify";
    case "google":
      return "Google";
    case "facebook":
    case "meta":
      return "Meta";
    default:
      return provider;
  }
}

function stripOAuthReturnQuery() {
  const url = new URL(window.location.href);
  if (
    !url.searchParams.has("ebay") &&
    !url.searchParams.has("connected") &&
    !url.searchParams.has("provider")
  ) {
    return;
  }
  url.searchParams.delete("ebay");
  url.searchParams.delete("connected");
  url.searchParams.delete("provider");
  url.searchParams.delete("code");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}` || "/");
}

function isLegalRoute(route: Route): route is { name: "privacy" } | { name: "terms" } {
  return route.name === "privacy" || route.name === "terms";
}

function isPublicRoute(route: Route): route is { name: "public"; token: string } {
  return route.name === "public";
}

function needsWorkspace(name: Route["name"]): boolean {
  return (
    name === "home" ||
    name === "proofs" ||
    name === "activity" ||
    name === "account" ||
    name === "proof" ||
    name === "fulfillment" ||
    name === "fulfillment-detail" ||
    name === "station" ||
    name === "stores"
  );
}

function PackProofApp() {
  const [session, setSession] = useState<WebSession | null>(() => loadSession());
  const [route, setRoute] = useState<Route>(() =>
    parseHref(`${window.location.pathname}${window.location.search}`),
  );
  const [proofs, setProofs] = useState<ProofCollectionItem[]>([]);
  const [invitations, setInvitations] = useState<InvitationInboxView[]>([]);
  const [proof, setProof] = useState<CanonicalProof | null>(null);
  const [shipmentIntegrity, setShipmentIntegrity] = useState<ShipmentIntegrityView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => oauthReturnError(window.location.href));
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [connectedNotice, setConnectedNotice] = useState<string | null>(() =>
    oauthReturnNotice(window.location.href),
  );
  const [queue, setQueue] = useState<FulfillmentQueueItem[]>([]);
  const [connections, setConnections] = useState<CommerceConnectionView[]>([]);
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccountView[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<ConnectedAccountProviderCatalogView[]>(
    [],
  );
  const [ebay, setEbay] = useState<EbayMarketplaceView | null>(null);
  const [lastSync, setLastSync] = useState<CommerceSyncView | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState(() => loadSession()?.displayName ?? "");
  const [usernameInput, setUsernameInput] = useState(() => loadSession()?.username ?? "");
  const tokenRef = useRef<string | null>(session?.token ?? null);

  useEffect(() => {
    stripOAuthReturnQuery();
  }, []);

  const api = useMemo(
    () =>
      new PackProofApi({
        baseUrl: session?.apiBaseUrl ?? "",
        getToken: () => tokenRef.current,
      }),
    [session?.apiBaseUrl],
  );

  const loadProofEvidence = useCallback(
    async (evidenceId: string) => {
      if (!proof) {
        throw new Error("Proof is not available.");
      }
      return api.getEvidenceBlob(proof.proofId, evidenceId);
    },
    [api, proof],
  );

  function signOut() {
    tokenRef.current = null;
    clearSession();
    setSession(null);
    setProofs([]);
    setInvitations([]);
    setProof(null);
    setShipmentIntegrity(null);
    setConnections([]);
    setConnectedAccounts([]);
    setConnectedProviders([]);
    setConnectedNotice(null);
    setError(null);
    writePath("/");
    setRoute({ name: "home" });
  }

  function go(path: string) {
    const next = parseHref(path);
    setError(null);
    setShareNotice(null);
    if (next.name !== "proof" || proof?.proofId !== next.proofId) {
      setProof(null);
      setShipmentIntegrity(null);
    }
    if (needsWorkspace(next.name)) {
      setLoading(true);
    }
    writePath(path);
    setRoute(next);
  }

  function handleError(caught: unknown): string {
    if (caught instanceof ApiError && caught.status === 401) {
      signOut();
      return "Session expired. Sign in again.";
    }
    if (caught instanceof ApiError && caught.code === "PARTICIPANT_NOT_AUTHORIZED") {
      return "This Proof is not available.";
    }
    const mapped = toUserFacingError(caught);
    if (mapped.title !== "Something went wrong.") {
      return formatUserFacingError(caught);
    }
    if (caught instanceof ApiError) {
      return caught.message;
    }
    return caught instanceof Error ? caught.message : mapped.message;
  }

  const searchProofUsers = useCallback(
    async (query: string) => {
      if (!proof) {
        return [];
      }
      const found = await api.searchProofUsers(proof.proofId, query);
      return found.users;
    },
    [api, proof],
  );

  const inviteProofUser = useCallback(
    async (input: { inviteeUserId: string }) => {
      if (!proof) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const result = await api.createInvitation(proof.proofId, input);
        setProof(result.proof);
      } catch (caught) {
        setError(handleError(caught));
        throw caught;
      } finally {
        setBusy(false);
      }
    },
    [api, proof],
  );

  function acceptInvitation(invitationId: string) {
    setBusy(true);
    void api
      .acceptInvitation(invitationId)
      .then((result) => go(`/proofs/${encodeURIComponent(result.proof.proofId)}`))
      .catch((caught) => setError(handleError(caught)))
      .finally(() => setBusy(false));
  }

  useEffect(() => {
    const onPop = () => {
      const next = parseHref(`${window.location.pathname}${window.location.search}`);
      if (next.name !== "proof") {
        setProof(null);
        setShipmentIntegrity(null);
      }
      if (needsWorkspace(next.name)) {
        setLoading(true);
      }
      setRoute(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    tokenRef.current = session?.token ?? null;
    if (session) {
      saveSession(session);
      setDisplayNameInput(session.displayName ?? "");
      setUsernameInput(session.username ?? "");
    }
  }, [session]);

  useEffect(() => {
    if (!session || !isProfileComplete(session)) {
      return;
    }
    if (route.name === "home" || route.name === "proofs" || route.name === "activity") {
      setLoading(true);
      setError(null);
      void Promise.all([api.listMyProofs(), api.listInvitations()])
        .then(([listed, inbox]) => {
          setProofs(listed.proofs);
          setInvitations(inbox.invitations);
        })
        .catch((caught) => setError(handleError(caught)))
        .finally(() => setLoading(false));
    }
    if (route.name === "account") {
      setLoading(true);
      void Promise.all([
        api.listInvitations(),
        api.listCommerceConnections(),
        api.listMarketplaces(),
        api.listConnectedAccounts(),
      ])
        .then(([inbox, listed, marketplaces, connected]) => {
          setInvitations(inbox.invitations);
          setConnections(listed.connections);
          setEbay(pickEbay(marketplaces));
          setConnectedAccounts(connected.accounts);
          setConnectedProviders(connected.providers);
        })
        .catch((caught) => setError(handleError(caught)))
        .finally(() => setLoading(false));
    }
    if (route.name === "proof") {
      setLoading(true);
      setError(null);
      setProof(null);
      setShipmentIntegrity(null);
      void api
        .getProof(route.proofId)
        .then(async (loaded) => {
          setProof(loaded);
          const integrity = await api.getShipmentIntegrity(loaded.proofId);
          setShipmentIntegrity(integrity);
        })
        .catch((caught) => setError(handleError(caught)))
        .finally(() => setLoading(false));
    }
    if (route.name === "fulfillment" || route.name === "fulfillment-detail" || route.name === "station") {
      setLoading(true);
      setError(null);
      void api
        .listFulfillmentQueue(route.name === "fulfillment-detail" ? "all" : "ready")
        .then((result) => setQueue(result.items))
        .catch((caught) => setError(handleError(caught)))
        .finally(() => setLoading(false));
    }
    if (route.name === "stores") {
      setLoading(true);
      void Promise.all([api.listCommerceConnections(), api.listMarketplaces()])
        .then(([listed, marketplaces]) => {
          setConnections(listed.connections);
          setEbay(pickEbay(marketplaces));
        })
        .catch((caught) => setError(handleError(caught)))
        .finally(() => setLoading(false));
    }
    if (route.name === "create") {
      void api
        .listMarketplaces()
        .then((marketplaces) => setEbay(pickEbay(marketplaces)))
        .catch(() => undefined);
    }
  }, [api, route, session]);

  if (isLegalRoute(route)) {
    return <LegalScreen kind={route.name} onGo={go} />;
  }

  if (isPublicRoute(route)) {
    return (
      <PublicProofScreen
        token={route.token}
        load={(token) => api.getPublicProof(token)}
        onSignIn={() => go("/")}
      />
    );
  }

  if (!session) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <span className="brand">
            <img src="/packproof-logo.png" alt="" width={28} height={28} />
            PackProof
          </span>
        </header>
        <SignInScreen
          onGo={go}
          onSignedIn={(next) => {
            tokenRef.current = next.token;
            setSession(next);
            go("/");
          }}
        />
      </div>
    );
  }

  if (!isProfileComplete(session)) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <span className="brand">
            <img src="/packproof-logo.png" alt="" width={28} height={28} />
            PackProof
          </span>
        </header>
        <ProfileSetupScreen
          session={session}
          onGo={go}
          onSignOut={signOut}
          onCompleted={(profile) => {
            setSession({
              ...session,
              username: profile.username,
              displayName: profile.displayName,
            });
          }}
        />
      </div>
    );
  }

  const showLibraryChrome = route.name === "home" || route.name === "proofs";
  const libraryProps = {
    proofs,
    invitations,
    loading,
    error,
    onOpenProof: (proofId: string) => go(`/proofs/${encodeURIComponent(proofId)}`),
    onCreate: () => go("/new"),
    onAccept: acceptInvitation,
  };

  return (
    <div className="app-shell">
      {showLibraryChrome ? (
        <AppNav
          session={session}
          invitationCount={invitations.length}
          onGoHome={() => go("/")}
          onOpenAccount={() => go("/account")}
        />
      ) : null}

      {route.name === "home" || route.name === "proofs" ? <HomeScreen {...libraryProps} /> : null}

      {route.name === "activity" ? (
        <ActivityScreen
          proofs={proofs}
          invitations={invitations}
          loading={loading}
          error={error}
          onOpenProof={(proofId) => go(`/proofs/${encodeURIComponent(proofId)}`)}
          onAccept={acceptInvitation}
        />
      ) : null}

      {route.name === "account" ? (
        <AccountScreen
          displayName={session.displayName}
          username={session.username}
          subject={session.subject}
          connections={connections}
          connectedAccounts={connectedAccounts}
          connectedProviders={connectedProviders}
          connectedNotice={connectedNotice}
          error={error}
          busy={busy}
          displayNameInput={displayNameInput}
          usernameInput={usernameInput}
          onDisplayNameChange={setDisplayNameInput}
          onUsernameChange={setUsernameInput}
          onSaveProfile={() => {
            setBusy(true);
            setError(null);
            void api
              .updateProfile({
                displayName: displayNameInput.trim() || undefined,
                username: session.username ? undefined : usernameInput.trim() || undefined,
              })
              .then((profile) => {
                setSession({
                  ...session,
                  username: profile.username,
                  displayName: profile.displayName,
                });
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onAcceptInvitation={acceptInvitation}
          onOpenStation={() => go("/station")}
          onOpenStores={() => go("/stores")}
          onOpenFulfillment={() => go("/fulfillment")}
          onOpenPrivacy={() => go("/new/privacy")}
          onOpenTerms={() => go("/new/terms")}
          onBack={() => go("/")}
          onConnectAccount={(provider, extra) => {
            setBusy(true);
            setError(null);
            void api
              .startConnectedAccountConnect(provider, extra)
              .then((result) => {
                window.location.assign(result.authorizationUrl);
              })
              .catch((caught) => {
                setError(handleError(caught));
                setBusy(false);
              });
          }}
          onReauthorizeAccount={(accountId) => {
            setBusy(true);
            setError(null);
            void api
              .reauthorizeConnectedAccount(accountId)
              .then((result) => {
                window.location.assign(result.authorizationUrl);
              })
              .catch((caught) => {
                setError(handleError(caught));
                setBusy(false);
              });
          }}
          onDisconnectAccount={(accountId) => {
            setBusy(true);
            setError(null);
            void api
              .disconnectConnectedAccount(accountId)
              .then(() => api.listConnectedAccounts())
              .then((listed) => {
                setConnectedAccounts(listed.accounts);
                setConnectedProviders(listed.providers);
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onSignOut={signOut}
        />
      ) : null}

      {route.name === "create" ? (
        <CreateProofScreen
          busy={busy}
          error={error}
          development={import.meta.env.DEV}
          ebayEnabled={ebay?.enabled === true}
          ebayConnected={ebay?.connection?.status === "ACTIVE"}
          onCancel={() => go("/")}
          onScan={() => go("/station")}
          onConnectEbay={() => {
            setBusy(true);
            setError(null);
            void api
              .startEbayConnect()
              .then((result) => {
                window.location.assign(result.authorizationUrl);
              })
              .catch((caught) => {
                setError(handleError(caught));
                setBusy(false);
              });
          }}
          onImportPurchase={() => {
            setBusy(true);
            setError(null);
            return api
              .importTransaction({ adapterKey: "demo-marketplace", createProof: false })
              .catch((caught) => {
                setError(handleError(caught));
                throw caught;
              })
              .finally(() => setBusy(false));
          }}
          onListEbayOrders={() => {
            setBusy(true);
            setError(null);
            return api
              .listEbaySellerOrders()
              .catch((caught) => {
                setError(handleError(caught));
                throw caught;
              })
              .finally(() => setBusy(false));
          }}
          onImportEbayOrder={(orderId) => {
            setBusy(true);
            setError(null);
            return api
              .importEbaySellerOrder(orderId, { createProof: false })
              .catch((caught) => {
                setError(handleError(caught));
                throw caught;
              })
              .finally(() => setBusy(false));
          }}
          onConfirmImport={(transactionId) => {
            setBusy(true);
            setError(null);
            void api
              .createOrGetProof(transactionId)
              .then((created) => go(`/proofs/${encodeURIComponent(created.proofId)}`))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onCreate={(input: TransactionWriteInput) => {
            setBusy(true);
            setError(null);
            void api
              .createTransaction(input)
              .then((txn) => api.createOrGetProof(txn.transactionId))
              .then((created) => go(`/proofs/${encodeURIComponent(created.proofId)}`))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onCreateGrading={(input) => {
            setBusy(true);
            setError(null);
            void api
              .createProof({
                workflowType: "GRADING_SUBMISSION",
                itemCount: input.itemCount,
                itemTitle: input.itemTitle,
              })
              .then((created) => go(`/proofs/${encodeURIComponent(created.proofId)}`))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}

      {route.name === "station" ? (
        <PackingStationScreen
          api={api}
          userId={session.userId}
          queue={queue.filter(
            (item) => item.workflowState !== "COMPLETED" && item.workflowState !== "REMOVED_FROM_FULFILLMENT",
          )}
          error={error}
          initialReference={route.reference}
          onAuthExpired={signOut}
          onLeave={() => go("/")}
        />
      ) : null}

      {route.name === "fulfillment" ? (
        <FulfillmentQueueScreen
          items={queue.filter(
            (item) => item.workflowState !== "COMPLETED" && item.workflowState !== "REMOVED_FROM_FULFILLMENT",
          )}
          loading={loading}
          error={error}
          onBack={() => go("/account")}
          onOpen={(proofId) => go(`/fulfillment/${encodeURIComponent(proofId)}`)}
        />
      ) : null}

      {route.name === "fulfillment-detail" ? (
        <FulfillmentDetailScreen
          item={queue.find((item) => item.proofId === route.proofId) ?? null}
          loading={loading}
          error={error}
          busy={busy}
          onAttest={() => {
            const current = queue.find((item) => item.proofId === route.proofId);
            if (!current) {
              return;
            }
            setBusy(true);
            setError(null);
            void api
              .createAttestation(current.proofId, { statement: "PACKED_DESCRIBED_ITEM" })
              .then(() => api.listFulfillmentQueue("all"))
              .then((result) => setQueue(result.items))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onComplete={() => {
            const current = queue.find((item) => item.proofId === route.proofId);
            if (!current) {
              return;
            }
            setBusy(true);
            setError(null);
            void api
              .finalizeProof(current.proofId)
              .then(() => api.listFulfillmentQueue("all"))
              .then((result) => {
                setQueue(result.items);
                go("/fulfillment");
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onCompleteAndNext={() => {
            const current = queue.find((item) => item.proofId === route.proofId);
            if (!current) {
              return;
            }
            setBusy(true);
            setError(null);
            void api
              .finalizeProof(current.proofId)
              .then(() => api.listFulfillmentQueue("ready"))
              .then((result) => {
                setQueue(result.items);
                const next = result.items[0];
                if (next) {
                  go(`/fulfillment/${encodeURIComponent(next.proofId)}`);
                } else {
                  go("/fulfillment");
                }
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onOpenProof={() => go(`/proofs/${encodeURIComponent(route.proofId)}`)}
          onOpenStation={() => {
            const current = queue.find((item) => item.proofId === route.proofId);
            const reference = current?.externalReference || current?.externalOrderId || "";
            go(reference ? `/station?reference=${encodeURIComponent(reference)}` : "/station");
          }}
        />
      ) : null}

      {route.name === "stores" ? (
        <ConnectedStoresScreen
          connections={connections}
          lastSync={lastSync}
          loading={loading}
          error={error}
          busy={busy}
          development={import.meta.env.DEV}
          ebay={ebay}
          onBack={() => go("/account")}
          onConnectEbay={() => {
            setBusy(true);
            setError(null);
            void api
              .startEbayConnect()
              .then((result) => {
                window.location.assign(result.authorizationUrl);
              })
              .catch((caught) => {
                setError(handleError(caught));
                setBusy(false);
              });
          }}
          onDisconnectEbay={() => {
            setBusy(true);
            setError(null);
            void api
              .disconnectEbay()
              .then(() => api.listMarketplaces())
              .then((listed) => setEbay(pickEbay(listed)))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onImportSales={() => go("/new")}
          onConnectDemo={() => {
            setBusy(true);
            setError(null);
            void api
              .connectDemoStorefront()
              .then(() => api.listCommerceConnections())
              .then((result) => setConnections(result.connections))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onSync={(connectionId) => {
            setBusy(true);
            setError(null);
            void api
              .syncCommerceConnection(connectionId)
              .then((result) => {
                setLastSync(result);
                return api.listCommerceConnections();
              })
              .then((result) => setConnections(result.connections))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}

      {route.name === "proof" ? (
        <ProofScreen
          proof={route.name === "proof" && proof?.proofId === route.proofId ? proof : null}
          shipmentIntegrity={shipmentIntegrity}
          currentUserId={session.userId}
          loading={loading}
          error={error}
          busy={busy}
          development={import.meta.env.DEV}
          shareNotice={shareNotice}
          onBack={() => go("/")}
          onSearchUsers={searchProofUsers}
          onInvite={inviteProofUser}
          onOpenStation={() => {
            const reference = proof?.transaction.externalReference || "";
            go(reference ? `/station?reference=${encodeURIComponent(reference)}` : "/station");
          }}
          onShare={() => {
            if (!proof) {
              return;
            }
            setBusy(true);
            setError(null);
            setShareNotice(null);
            void api
              .createAccessLink(proof.proofId, { scope: "SUMMARY" })
              .then(async (link) => {
                const url = link.url || `${window.location.origin}/p/${link.token ?? ""}`;
                try {
                  await navigator.clipboard.writeText(url);
                  setShareNotice("Viewing link copied. Anyone with the link can see live status. They cannot change the Proof.");
                } catch {
                  setShareNotice(url);
                }
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onWorkflowAction={async (action, body = {}) => {
            if (!proof) {
              return;
            }
            setBusy(true);
            setError(null);
            try {
              const result = await api.runProofAction(proof.proofId, action, {
                ...body,
                idempotencyKey: crypto.randomUUID(),
              });
              setProof(result.proof);
            } catch (caught) {
              setError(handleError(caught));
              throw caught;
            } finally {
              setBusy(false);
            }
          }}
          onCommitCapture={async (files) => {
            if (!proof) {
              return [];
            }
            setBusy(true);
            setError(null);
            try {
              const evidenceType = captureEvidenceType({
                workflowType: proof.workflowType,
                captureRecipe: proof.nextAction?.captureRecipe,
                nextActionType: proof.nextAction?.type,
              });
              const committed: Array<{ slot: string; evidenceId: string }> = [];
              for (const row of files) {
                const contentType = row.file.type || "application/octet-stream";
                const initialized = await api.initializeEvidenceUpload(proof.proofId, {
                  contentType,
                  evidenceType,
                  idempotencyKey: crypto.randomUUID(),
                });
                await api.uploadObject(initialized.upload, row.file, contentType);
                await api.commitEvidence(proof.proofId, initialized.evidenceId);
                committed.push({ slot: row.slot, evidenceId: initialized.evidenceId });
              }
              return committed;
            } catch (caught) {
              setError(handleError(caught));
              throw caught;
            } finally {
              setBusy(false);
            }
          }}
          onLoadEvidence={loadProofEvidence}
          onAttest={(statement) => {
            if (!proof) {
              return;
            }
            setBusy(true);
            void api
              .createAttestation(proof.proofId, { statement })
              .then((result) => setProof(result.proof))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onFinalize={() => {
            if (!proof) {
              return;
            }
            setBusy(true);
            void api
              .finalizeProof(proof.proofId)
              .then(async (result) => {
                setProof(result.proof);
                setShipmentIntegrity(await api.getShipmentIntegrity(result.proof.proofId));
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onImportShipmentEvents={(throughEventType) => {
            if (!proof) {
              return;
            }
            setBusy(true);
            setError(null);
            void api
              .importShipmentEvents({
                adapterKey: "demo-carrier",
                transactionId: proof.transactionId,
                throughEventType: throughEventType ?? null,
              })
              .then(() => api.getProof(proof.proofId))
              .then(async (loaded) => {
                setProof(loaded);
                setShipmentIntegrity(await api.getShipmentIntegrity(loaded.proofId));
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onSyncShipment={() => {
            if (!proof) {
              return;
            }
            setBusy(true);
            setError(null);
            void api
              .syncShipment(proof.transactionId)
              .then(() => api.getProof(proof.proofId))
              .then(async (loaded) => {
                setProof(loaded);
                setShipmentIntegrity(await api.getShipmentIntegrity(loaded.proofId));
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onConnectTrustedDemo={
            import.meta.env.DEV
              ? () => {
                  if (!proof) {
                    return;
                  }
                  setBusy(true);
                  setError(null);
                  void api
                    .connectTrustedDemo(proof.transactionId)
                    .then(() => api.getProof(proof.proofId))
                    .then(async (loaded) => {
                      setProof(loaded);
                      setShipmentIntegrity(await api.getShipmentIntegrity(loaded.proofId));
                    })
                    .catch((caught) => setError(handleError(caught)))
                    .finally(() => setBusy(false));
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <PackProofApp />
    </ThemeProvider>
  );
}
