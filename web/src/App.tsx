import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatUserFacingError, toUserFacingError } from "@packproof/copy/errors";
import { PackProofApi } from "./api/client";
import { ApiError } from "./api/types";
import type {
  CanonicalProof,
  CommerceConnectionView,
  CommerceSyncView,
  FulfillmentQueueItem,
  InvitationInboxView,
  ProofCollectionItem,
  ShipmentIntegrityView,
  TransactionWriteInput,
} from "./api/types";
import { clearSession, loadSession, saveSession, type WebSession } from "./auth/session";
import { AppNav, type AppRouteName } from "./components/AppNav";
import { AccountScreen } from "./screens/AccountScreen";
import { ActivityScreen } from "./screens/ActivityScreen";
import { ConnectedStoresScreen } from "./screens/ConnectedStoresScreen";
import { CreateProofScreen } from "./screens/CreateProofScreen";
import { FulfillmentDetailScreen } from "./screens/FulfillmentDetailScreen";
import { FulfillmentQueueScreen } from "./screens/FulfillmentQueueScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { PackingStationScreen } from "./screens/PackingStationScreen";
import { ProofsScreen } from "./screens/ProofsScreen";
import { ProofScreen } from "./screens/ProofScreen";
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
  | { name: "stores" };

function parseHref(href: string): Route {
  const url = new URL(href, "http://packproof.local");
  const pathname = url.pathname;
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

export function App() {
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
  const [error, setError] = useState<string | null>(null);
  const [queue, setQueue] = useState<FulfillmentQueueItem[]>([]);
  const [connections, setConnections] = useState<CommerceConnectionView[]>([]);
  const [lastSync, setLastSync] = useState<CommerceSyncView | null>(null);
  const tokenRef = useRef<string | null>(session?.token ?? null);

  const api = useMemo(
    () =>
      new PackProofApi({
        baseUrl: session?.apiBaseUrl ?? "",
        getToken: () => tokenRef.current,
      }),
    [session?.apiBaseUrl],
  );

  function signOut() {
    tokenRef.current = null;
    clearSession();
    setSession(null);
    setProofs([]);
    setInvitations([]);
    setProof(null);
    setShipmentIntegrity(null);
    setError(null);
    writePath("/");
    setRoute({ name: "home" });
  }

  function go(path: string) {
    const next = parseHref(path);
    setError(null);
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
    if (caught instanceof ApiError && caught.status === 403) {
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
      setLoading(true);
      setRoute(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    tokenRef.current = session?.token ?? null;
    if (session) {
      saveSession(session);
    }
  }, [session]);

  useEffect(() => {
    if (!session) {
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
      setError(null);
      void Promise.all([api.listInvitations(), api.listCommerceConnections()])
        .then(([inbox, listed]) => {
          setInvitations(inbox.invitations);
          setConnections(listed.connections);
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
      setError(null);
      void api
        .listCommerceConnections()
        .then((result) => setConnections(result.connections))
        .catch((caught) => setError(handleError(caught)))
        .finally(() => setLoading(false));
    }
  }, [api, route, session]);

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
          onSignedIn={(next) => {
            tokenRef.current = next.token;
            setSession(next);
            go("/");
          }}
        />
      </div>
    );
  }

  const routeName: AppRouteName = route.name;

  return (
    <div className="app-shell">
      <AppNav routeName={routeName} session={session} onGo={go} onSignOut={signOut} />

      {route.name === "home" ? (
        <HomeScreen
          proofs={proofs}
          invitations={invitations}
          displayName={session.displayName}
          username={session.username}
          loading={loading}
          error={error}
          onOpenProof={(proofId) => go(`/proofs/${encodeURIComponent(proofId)}`)}
          onCreate={() => go("/new")}
          onOpenStation={() => go("/station")}
          onOpenFulfillment={() => go("/fulfillment")}
          onOpenStores={() => go("/stores")}
          onAccept={acceptInvitation}
        />
      ) : null}

      {route.name === "proofs" ? (
        <ProofsScreen
          proofs={proofs}
          invitations={invitations}
          loading={loading}
          error={error}
          onOpenProof={(proofId) => go(`/proofs/${encodeURIComponent(proofId)}`)}
          onCreate={() => go("/new")}
          onAccept={acceptInvitation}
        />
      ) : null}

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
          error={error}
          busy={busy}
          onAcceptInvitation={acceptInvitation}
          onOpenStation={() => go("/station")}
          onOpenStores={() => go("/stores")}
          onSignOut={signOut}
        />
      ) : null}

      {route.name === "create" ? (
        <CreateProofScreen
          busy={busy}
          error={error}
          onCancel={() => go("/")}
          onScan={() => go("/station")}
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
        />
      ) : null}

      {route.name === "fulfillment" ? (
        <FulfillmentQueueScreen
          items={queue.filter(
            (item) => item.workflowState !== "COMPLETED" && item.workflowState !== "REMOVED_FROM_FULFILLMENT",
          )}
          loading={loading}
          error={error}
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
          onSearchUsers={searchProofUsers}
          onInvite={inviteProofUser}
          onOpenStation={() => {
            const reference = proof?.transaction.externalReference || "";
            go(reference ? `/station?reference=${encodeURIComponent(reference)}` : "/station");
          }}
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
