import { useEffect, useMemo, useRef, useState } from "react";
import { PackProofApi } from "./api/client";
import { ApiError } from "./api/types";
import type { CanonicalProof, InvitationInboxView, ProofCollectionItem, TransactionWriteInput } from "./api/types";
import { clearSession, loadSession, saveSession, type WebSession } from "./auth/session";
import { CreateProofScreen } from "./screens/CreateProofScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { ProofScreen } from "./screens/ProofScreen";
import { SignInScreen } from "./screens/SignInScreen";

type Route =
  | { name: "home" }
  | { name: "create" }
  | { name: "proof"; proofId: string };

function parseRoute(pathname: string): Route {
  if (pathname === "/new") {
    return { name: "create" };
  }
  const proof = pathname.match(/^\/proofs\/([^/]+)$/);
  if (proof?.[1]) {
    return { name: "proof", proofId: decodeURIComponent(proof[1]) };
  }
  return { name: "home" };
}

function writePath(path: string) {
  if (window.location.pathname !== path) {
    window.history.pushState(null, "", path);
  }
}

export function App() {
  const [session, setSession] = useState<WebSession | null>(() => loadSession());
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [proofs, setProofs] = useState<ProofCollectionItem[]>([]);
  const [invitations, setInvitations] = useState<InvitationInboxView[]>([]);
  const [proof, setProof] = useState<CanonicalProof | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    writePath("/");
    setRoute({ name: "home" });
  }

  function go(path: string) {
    const next = parseRoute(path);
    setError(null);
    if (next.name !== "proof" || proof?.proofId !== next.proofId) {
      setProof(null);
    }
    if (next.name === "home" || next.name === "proof") {
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
    if (caught instanceof ApiError) {
      return caught.message;
    }
    return caught instanceof Error ? caught.message : String(caught);
  }

  useEffect(() => {
    const onPop = () => {
      const next = parseRoute(window.location.pathname);
      if (next.name !== "proof") {
        setProof(null);
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
    if (route.name === "home") {
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
    if (route.name === "proof") {
      setLoading(true);
      setError(null);
      setProof(null);
      void api
        .getProof(route.proofId)
        .then((loaded) => setProof(loaded))
        .catch((caught) => setError(handleError(caught)))
        .finally(() => setLoading(false));
    }
  }, [api, route, session]);

  if (!session) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <span className="brand">PackProof</span>
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            go("/");
          }}
        >
          PackProof
        </a>
        <div className="topbar-meta">
          <span>{session.displayName || session.username || session.subject}</span>
          <button className="btn btn-secondary" type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      {route.name === "home" ? (
        <HomeScreen
          proofs={proofs}
          invitations={invitations}
          loading={loading}
          error={error}
          onOpenProof={(proofId) => go(`/proofs/${encodeURIComponent(proofId)}`)}
          onCreate={() => go("/new")}
          onAccept={(invitationId) => {
            setBusy(true);
            void api
              .acceptInvitation(invitationId)
              .then((result) => go(`/proofs/${encodeURIComponent(result.proof.proofId)}`))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}

      {route.name === "create" ? (
        <CreateProofScreen
          busy={busy}
          error={error}
          onCancel={() => go("/")}
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

      {route.name === "proof" ? (
        <ProofScreen
          proof={route.name === "proof" && proof?.proofId === route.proofId ? proof : null}
          currentUserId={session.userId}
          loading={loading}
          error={error}
          busy={busy}
          onSearchUsers={async (query) => {
            const found = await api.searchUsers(query);
            return found.users;
          }}
          onInvite={(input) => {
            if (!proof) {
              return;
            }
            setBusy(true);
            void api
              .createInvitation(proof.proofId, input)
              .then((result) => setProof(result.proof))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
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
              .then((result) => setProof(result.proof))
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
              .then((loaded) => setProof(loaded))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}
    </div>
  );
}
