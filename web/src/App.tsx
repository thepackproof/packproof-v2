import {CaptureLaunchScreen,retainCaptureLaunch} from "./screens/CaptureLaunchScreen";
import type {EngineSession} from "./capture/engine";
import { applyLocalWork } from "./proof-presentation";
import { listRecoverableRecordings } from "./capture-queue";
import { randomId } from "./random-id";
import { LocalRecordingRecovery } from "./components/LocalRecordingRecovery";
import { clearViewState, saveNavigationContext, setNavigationScope } from "./navigation-context";
import { ConnectedAccountsPanel } from "./screens/ConnectedAccountsPanel";
import { preserveCapture, recoverCapture, captureQueueKey } from "./capture-queue";
import { ProofsScreen } from "./screens/ProofsScreen";
import { canonicalWorkspacePath, readProofListState, rememberProofListState } from "./proof-list-state";
import { ReceiptScreen } from "./screens/ReceiptScreen";
import { DeveloperScreen } from "./screens/DeveloperScreen";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReadyIntakeOrders } from './components/ReadyIntakeOrders';
import { IntakeSettingsPanel } from './components/IntakeSettingsPanel';
import { CompanionBridge } from './components/CompanionBridge';
import { SelectedOrderHandoff } from './components/SelectedOrderHandoff';
import type { IntakeSnapshot } from './intake-types';
import { formatUserFacingError, toUserFacingError } from "@packproof/copy/errors";
import { captureEvidenceType } from "@packproof/copy/custody";
import { PackProofApi } from "./api/client";
import { createSessionTokenProvider } from "./auth/token-provider";
import { cognitoRefresh, defaultCognitoConfig } from "./auth/cognito";
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
import {
  clearSession,
  defaultApiBaseUrl,
  isProfileComplete,
  loadSession,
  saveSession,
  type WebSession,
} from "./auth/session";
import { AppNav } from "./components/AppNav";
import { ThemeProvider } from "./theme/ThemeProvider";
import { AccountDeletionScreen } from "./screens/AccountDeletionScreen";
import { AccountScreen } from "./screens/AccountScreen";
import { ConnectedStoresScreen } from "./screens/ConnectedStoresScreen";
import { CreateProofScreen } from "./screens/CreateProofScreen";
import { EventDetailScreen } from "./screens/EventDetailScreen";
import { FinalizeScreen } from "./screens/FinalizeScreen";
import { InvitationReviewScreen } from "./screens/InvitationReviewScreen";
import { InviteScreen } from "./screens/InviteScreen";
import { PackingStationScreen } from "./screens/PackingStationScreen";
import { ProofScreen } from "./screens/ProofScreen";
import { PublicProofScreen } from "./screens/PublicProofScreen";
import { LegalScreen } from "./screens/LegalScreen";
import { ProfileSetupScreen } from "./screens/ProfileSetupScreen";
import { ScanCreateScreen } from "./screens/ScanCreateScreen";
import { SignInScreen } from "./screens/SignInScreen";
import { AuthFrame } from "./site/PublicSite";

type Route =
  | { name: "proofs"; view: "all" | "attention" | "completed"; query: string }
  | { name: "capture-launch" }
  | { name: "create" }
  | { name: "scan" }
  | { name: "account" }
  | { name: "delete-account" }
  | { name: "developer" }
  | { name: "receipt"; proofId: string }
  | { name: "proof"; proofId: string }
  | { name: "invite"; proofId: string }
  | { name: "finalize"; proofId: string }
  | { name: "event"; proofId: string; eventId: string }
  | { name: "invitation"; invitationId: string }
  | { name: "station"; reference?: string; proofId?: string }
  | { name: "stores" }
  | { name: "privacy" }
  | { name: "terms" }
  | { name: "public"; token: string };

function parseHref(href: string): Route {
  const url = new URL(canonicalWorkspacePath(href), "http://packproof.local");
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (pathname === "/new/delete-account") return { name: "delete-account" };
  if (pathname === "/new/privacy") {
    return { name: "privacy" };
  }
  if (pathname === "/new/terms") {
    return { name: "terms" };
  }
  if (pathname === "/new/scan") {
    return { name: "create" };
  }
  if (pathname === "/new") {
    return { name: "create" };
  }
  if (pathname === "/proofs") {
    return { name: "proofs", ...readProofListState(url) };
  }
  if (pathname === "/capture") return {name:"capture-launch"};
  if (pathname === "/developer") return { name: "developer" };
  if (pathname === "/account") {
    return { name: "account" };
  }
  const capture = pathname.match(/^\/proofs\/([^/]+)\/capture$/);
  if (capture) return { name: "station", proofId: decodeURIComponent(capture[1]), reference: url.searchParams.get("reference") || undefined };
  if (pathname === "/stores") {
    return { name: "stores" };
  }
  const receipt = pathname.match(/^\/receipt\/([^/]+)$/);
  if (receipt) return { name: "receipt", proofId: decodeURIComponent(receipt[1]) };
  const shared = pathname.match(/^\/p\/([^/]+)$/);
  if (shared?.[1]) {
    return { name: "public", token: decodeURIComponent(shared[1]) };
  }
  const invitation = pathname.match(/^\/invitations\/([^/]+)$/);
  if (invitation?.[1]) {
    return {
      name: "invitation",
      invitationId: decodeURIComponent(invitation[1]),
    };
  }
  const invite = pathname.match(/^\/proofs\/([^/]+)\/invite$/);
  if (invite?.[1]) {
    return { name: "invite", proofId: decodeURIComponent(invite[1]) };
  }
  const finalize = pathname.match(/^\/proofs\/([^/]+)\/finalize$/);
  if (finalize?.[1]) {
    return { name: "finalize", proofId: decodeURIComponent(finalize[1]) };
  }
  const event = pathname.match(/^\/proofs\/([^/]+)\/events\/([^/]+)$/);
  if (event?.[1] && event[2]) {
    return {
      name: "event",
      proofId: decodeURIComponent(event[1]),
      eventId: decodeURIComponent(event[2]),
    };
  }
  const proof = pathname.match(/^\/proofs\/([^/]+)$/);
  if (proof?.[1]) {
    return { name: "proof", proofId: decodeURIComponent(proof[1]) };
  }
  return { name: "proofs", view: "all", query: "" };
}

function routeProofId(route: Route): string | null {
  switch (route.name) {
    case "proof":
    case "invite":
    case "finalize":
    case "event":
      return route.proofId;
    default:
      return null;
  }
}

function writePath(path: string) {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current !== path) {
    saveNavigationContext();
    window.history.pushState({ ppContext: randomId(), ppFrom: current }, "", path);
    window.dispatchEvent(new Event("packproof:navigate"));
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
    case "etsy":
      return "Etsy";
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
    name === "proofs" ||
    name === "account" ||
    name === "proof" ||
    name === "invite" ||
    name === "finalize" ||
    name === "event" ||
    name === "invitation" ||
    name === "scan" ||
    name === "station" ||
    name === "stores"
  );
}

function needsProof(name: Route["name"]): boolean {
  return (
    name === "proof" ||
    name === "invite" ||
    name === "finalize" ||
    name === "event"
  );
}

function PackProofApp({ authInitialView }: { authInitialView?: "sign-in" | "create-account" }) {
  const [session, setSession] = useState<WebSession | null>(() => loadSession());
  const [route, setRoute] = useState<Route>(() =>
    parseHref(`${window.location.pathname}${window.location.search}`),
  );
  const [listRetry, setListRetry] = useState(0);
  const [proofs, setProofs] = useState<ProofCollectionItem[]>([]);
  const [invitations, setInvitations] = useState<InvitationInboxView[]>([]);
  const [proof, setProof] = useState<CanonicalProof | null>(null);
  const [captureEngineSession,setCaptureEngineSession]=useState<EngineSession|null>(null);
  const [acceptedIntakeSnapshot,setAcceptedIntakeSnapshot]=useState<IntakeSnapshot|null>(null);
  const [shipmentIntegrity, setShipmentIntegrity] = useState<ShipmentIntegrityView | null>(null);
  const [loading, setLoading] = useState(() => Boolean(loadSession()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => oauthReturnError(window.location.href));
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [connectedNotice, setConnectedNotice] = useState<string | null>(() =>
    oauthReturnNotice(window.location.href),
  );
  const [queue, setQueue] = useState<FulfillmentQueueItem[]>([]);
  const [connections, setConnections] = useState<CommerceConnectionView[]>([]);
  const [connectedAccounts, setConnectedAccounts] = useState<ConnectedAccountView[]>([]);
  const [connectedProviders, setConnectedProviders] = useState<
    ConnectedAccountProviderCatalogView[]
  >([]);
  const [ebay, setEbay] = useState<EbayMarketplaceView | null>(null);
  const [lastSync, setLastSync] = useState<CommerceSyncView | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState(() => loadSession()?.displayName ?? "");
  const [usernameInput, setUsernameInput] = useState(() => loadSession()?.username ?? "");
  const tokenRef = useRef<string | null>(session?.token ?? null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const getSessionToken = useMemo(() => createSessionTokenProvider({
    getSession: () => sessionRef.current,
    onSession: (updated) => {
      sessionRef.current = updated;
      tokenRef.current = updated.token;
      setSession(updated);
    },
    refresh: (token) => cognitoRefresh(defaultCognitoConfig(), token),
  }), []);
  const proofIdRef = useRef<string | null>(null);

  useEffect(() => {
    setNavigationScope(session ? `${session.apiBaseUrl}.${session.userId}` : "guest");
    const path = canonicalWorkspacePath(window.location.href, session ? `${session.apiBaseUrl}.${session.userId}` : undefined);
    if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== path) {
      window.history.replaceState(window.history.state, "", path);
      setRoute(parseHref(path));
    }
  }, [session?.userId, session?.apiBaseUrl]);

  useEffect(() => {
    stripOAuthReturnQuery();
  }, []);

  const api = useMemo(
    () =>
      new PackProofApi({
        baseUrl: session?.apiBaseUrl ?? defaultApiBaseUrl(),
        getToken: async () => {
          if (sessionRef.current?.userId !== session?.userId || sessionRef.current?.apiBaseUrl !== session?.apiBaseUrl) return null;
          const token = await getSessionToken();
          return sessionRef.current?.userId === session?.userId && sessionRef.current?.apiBaseUrl === session?.apiBaseUrl ? token : null;
        },
        getIdentityToken: () => sessionRef.current?.userId === session?.userId && sessionRef.current?.apiBaseUrl === session?.apiBaseUrl ? sessionRef.current?.idToken ?? null : null,
      }),
    [session?.apiBaseUrl, session?.userId, getSessionToken],
  );
  const loadPublicProof = useCallback((token: string) => api.getPublicProof(token), [api]);

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
    setAcceptedIntakeSnapshot(null);
    sessionRef.current = null;
    tokenRef.current = null;
    clearSession();
    clearViewState();
    setSession(null);
    setProofs([]);
    setQueue([]);
    setInvitations([]);
    setProof(null);
    setShipmentIntegrity(null);
    proofIdRef.current = null;
    setConnections([]);
    setConnectedAccounts([]);
    setConnectedProviders([]);
    setConnectedNotice(null);
    setError(null);
    writePath("/");
    setRoute({ name: "proofs", view: "all", query: "" });
  }

  function go(path: string) {
    if (path === "/" && !isLegalRoute(route)) path = "/proofs";
    path = canonicalWorkspacePath(path, session ? `${session.apiBaseUrl}.${session.userId}` : undefined);
    const next = parseHref(path);
    setError(null);
    const nextId = routeProofId(next);
    if (!nextId || nextId !== proofIdRef.current) {
      setProof(null);
      setShipmentIntegrity(null);
      proofIdRef.current = null;
    }
    if (needsWorkspace(next.name)) {
      setLoading(true);
    }
    writePath(path);
    setRoute(next);
  }

  function goBack(fallback: string) {
    if (window.history.state?.ppFrom) { saveNavigationContext(); window.history.back(); }
    else go(fallback);
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
      const nextId = routeProofId(next);
      if (!nextId || nextId !== proofIdRef.current) {
        setProof(null);
        setShipmentIntegrity(null);
        proofIdRef.current = null;
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
    let cancelled = false;
    const fail = (caught: unknown) => {
      if (!cancelled) setError(handleError(caught));
    };
    const finished = () => {
      if (!cancelled) setLoading(false);
    };
    if (route.name === "proofs") {
      setLoading(true);
      setError(null);
      rememberProofListState(`${session.apiBaseUrl}.${session.userId}`, { view: route.view, query: route.query });
      void Promise.all([api.listProofs({ view: "all", q: route.query }), listRecoverableRecordings(session.userId, api).catch(() => [])])
        .then(([listed, local]) => {
          if (cancelled) return;
          const rows = listed.proofs.map(item => applyLocalWork(item, local.find(recording => recording.proofId === item.proofId)));
          const visible = rows.filter(item => route.view === "all" || (route.view === "attention" ? item.presentation.needsAttention : item.presentation.completed));
          visible.sort((a, b) => {
            if (route.view !== "completed" && a.presentation.needsAttention !== b.presentation.needsAttention) return Number(b.presentation.needsAttention) - Number(a.presentation.needsAttention);
            const first = Date.parse(route.view === "completed" ? a.finalizedAt || "" : a.updatedAt) || 0;
            const second = Date.parse(route.view === "completed" ? b.finalizedAt || "" : b.updatedAt) || 0;
            return second - first || a.proofId.localeCompare(b.proofId);
          });
          setProofs(visible);
        })
        .catch(fail)
        .finally(finished);
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
          if (cancelled) return;
          setInvitations(inbox.invitations);
          setConnections(listed.connections);
          setEbay(pickEbay(marketplaces));
          setConnectedAccounts(connected.accounts);
          setConnectedProviders(connected.providers);
        })
        .catch(fail)
        .finally(finished);
    }
    if (needsProof(route.name)) {
      const proofId = routeProofId(route);
      if (proofId && proofIdRef.current !== proofId) {
        setLoading(true);
        setError(null);
        setProof(null);
        setShipmentIntegrity(null);
        void api
          .getProof(proofId)
          .then(async (loaded) => {
            if (cancelled) return;
            proofIdRef.current = loaded.proofId;
            setProof(loaded);
            const integrity = await api.getShipmentIntegrity(loaded.proofId);
            if (cancelled) return;
            setShipmentIntegrity(integrity);
          })
          .catch(fail)
          .finally(finished);
      } else {
        setLoading(false);
      }
    }
    if (route.name === "invitation") {
      setLoading(true);
      void api
        .listInvitations()
        .then((inbox) => { if (!cancelled) setInvitations(inbox.invitations); })
        .catch(fail)
        .finally(finished);
    }
    if (route.name === "station") {
      setLoading(false);
      setQueue([]);
    }
    if (route.name === "stores") {
      setLoading(true);
      void Promise.all([api.listCommerceConnections(), api.listMarketplaces(), api.listConnectedAccounts()])
        .then(([listed, marketplaces, accounts]) => {
          if (cancelled) return;
          setConnections(listed.connections);
          setEbay(pickEbay(marketplaces));
          setConnectedAccounts(accounts.accounts);
          setConnectedProviders(accounts.providers);
        })
        .catch(fail)
        .finally(finished);
    }
    if (route.name === "create") {
      void api
        .listMarketplaces()
        .then((marketplaces) => { if (!cancelled) setEbay(pickEbay(marketplaces)); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [api, route, session?.userId, session?.username, session?.displayName, listRetry]);

  if (route.name === "delete-account") {
    return <AccountDeletionScreen api={session ? api : undefined} accountKey={session?.userId}
      onSignIn={() => { sessionStorage.setItem("packproof.auth-return", "/new/delete-account"); go("/login"); }}
      onBack={() => go(session ? "/account" : "/")} />;
  }

  useEffect(() => {
    if (route.name !== "proof") return;
    let active = true;
    const refresh = () => { void api.getProof(route.proofId).then(updated => { if (active && proofIdRef.current === route.proofId) setProof(updated); }).catch(() => {}); };
    window.addEventListener("packproof:records-updated", refresh);
    return () => { active = false; window.removeEventListener("packproof:records-updated", refresh); };
  }, [api, route.name, route.name === "proof" ? route.proofId : null]);

  if (isLegalRoute(route)) {
    return <LegalScreen kind={route.name} onGo={go} />;
  }

  if (isPublicRoute(route)) {
    return (
      <PublicProofScreen
        key={route.token}
        apiBaseUrl={session?.apiBaseUrl ?? defaultApiBaseUrl()}
        token={route.token}
        load={loadPublicProof}
        loadMedia={(id) => api.getPublicEvidence(route.token, id)}
        onSignIn={() => go("/")}
      />
    );
  }

  if (!session) {
    return (
      <AuthFrame>
        <SignInScreen
          initialView={authInitialView}
          onGo={go}
          onSignedIn={(next) => {
            sessionRef.current = next;
            tokenRef.current = next.token;
            setSession(next);
            const authReturn = sessionStorage.getItem("packproof.auth-return");
            sessionStorage.removeItem("packproof.auth-return");
            if (authReturn === "/new/delete-account") go(authReturn);
            else if (["/login", "/signup", "/"].includes(window.location.pathname)) go("/proofs");
            // Keep the requested Proof or receiver invitation through sign-in.
            // The current route is already guarded until the session/profile is ready.
            setError(null);
          }}
        />
      </AuthFrame>
    );
  }

  if (!isProfileComplete(session)) {
    return (
      <AuthFrame>
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
      </AuthFrame>
    );
  }

  const libraryProps = {
    proofs, loading, error,
    view: route.name === "proofs" ? route.view : "all" as const,
    query: route.name === "proofs" ? route.query : "",
    onChange: (view: "all" | "attention" | "completed", query: string) => {
      const parameters = new URLSearchParams();
      parameters.set("filter", view);
      if (query) parameters.set("q", query);
      go(`/proofs${parameters.size ? `?${parameters}` : ""}`);
    },
    onRetry: () => setListRetry(value => value + 1),
    onOpenProof: (proofId: string) => go(`/proofs/${encodeURIComponent(proofId)}`),
    onCreate: () => go("/new"),
    onOpenReceiver: (proofId: string) => go(`/receipt/${encodeURIComponent(proofId)}`),
    onOpenInvitation: (invitationId: string) => go(`/invitations/${encodeURIComponent(invitationId)}`),
  };

  return (
    <div className="app-shell workspace-shell">
        {(route.name==='proofs'||route.name==='create')&&<CompanionBridge api={api} userId={session.userId} connections={connections}/>}
        {route.name==='proof'&&proof?.status==='READY_FOR_EVIDENCE'&&proof.workflowType==='COMMERCE_SALE'&&proof.participationPolicy==='COUNTERPARTY_OPTIONAL'&&<SelectedOrderHandoff key={proof.proofId} api={api} userId={session.userId} transactionId={proof.transaction.transactionId}/>}
        <AppNav
          session={session}
          invitationCount={invitations.length}
          currentRoute={route.name}
          onGo={go}
          onGoHome={() => go("/")}
          onOpenAccount={() => go("/account")}
        />

      <LocalRecordingRecovery visible={route.name === "account"} key={session.userId} api={api} userId={session.userId} onOpen={id => go(`/proofs/${encodeURIComponent(id)}`)} />

      {route.name === "proofs" ? <ProofsScreen {...libraryProps} readyOrders={<ReadyIntakeOrders api={api} userId={session.userId} onRecord={snapshot=>{setAcceptedIntakeSnapshot(snapshot);go(`/proofs/${encodeURIComponent(snapshot.proofId)}/capture`);}} />} /> : null}

      {route.name === "receipt" ? (
        <ReceiptScreen
          userId={session.userId}
          key={route.proofId}
          api={api}
          proofId={route.proofId}
          onBack={() => goBack("/")}
        />
      ) : null}
      {route.name === "developer" ? (
        <DeveloperScreen api={api} onBack={() => goBack("/account")} />
      ) : null}

      {route.name === "account" ? (
        <AccountScreen
          key={`account:${session.userId}`}
          userId={session.userId}
          onOpenProof={id => go(`/proofs/${encodeURIComponent(id)}`)}
          api={api}
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
          onOpenDeveloper={() => go("/developer")}
          onOpenStation={() => go("/station")}
          onOpenStores={() => go("/stores")}
          onOpenFulfillment={() => go("/fulfillment")}
          onOpenPrivacy={() => go("/new/privacy")}
          onOpenTerms={() => go("/new/terms")}
          onBack={() => goBack("/")}
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
          readyOrders={<ReadyIntakeOrders api={api} userId={session.userId} onRecord={snapshot=>{setAcceptedIntakeSnapshot(snapshot);go(`/proofs/${encodeURIComponent(snapshot.proofId)}/capture`);}} />}
          onPreviewIntake={(text) => api.previewOrderIntake(text)}
          busy={busy}
          error={error}
          development={import.meta.env.DEV}
          ebayConnected={ebay?.connection?.status === "ACTIVE"}
          onCancel={() => go("/")}
          onScan={() => go("/new/scan")}
          onOpenAccount={() => go("/account")}
          onAcceptInvitation={acceptInvitation}
          onImportPurchase={() => {
            setBusy(true);
            setError(null);
            return api
              .importTransaction({
                adapterKey: "demo-marketplace",
                createProof: false,
              })
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
              .then((created) => go(`/proofs/${encodeURIComponent(created.proofId)}/capture`))
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

      {route.name === "scan" ? (
        <ScanCreateScreen
          busy={busy}
          error={error}
          onBack={() => goBack("/new")}
          onIdentify={(reference) => {
            setBusy(true);
            setError(null);
            return api
              .resolvePackingStation(reference)
              .catch((caught) => {
                if (
                  caught instanceof ApiError &&
                  (caught.code === "STATION_REFERENCE_NOT_FOUND" ||
                    caught.code === "TRANSACTION_NOT_FOUND")
                ) {
                  throw caught;
                }
                setError(handleError(caught));
                throw caught;
              })
              .finally(() => setBusy(false));
          }}
          onContinue={(transactionId) => {
            setBusy(true);
            setError(null);
            void api
              .createOrGetProof(transactionId)
              .then((created) => go(`/proofs/${encodeURIComponent(created.proofId)}`))
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
          onImport={() => go("/new")}
          onManual={() => go("/new")}
        />
      ) : null}

      {route.name === "invitation" ? (
        <InvitationReviewScreen
          invite={invitations.find((item) => item.invitationId === route.invitationId) ?? null}
          busy={busy}
          error={error}
          onBack={() => goBack("/")}
          onReview={() => acceptInvitation(route.invitationId)}
        />
      ) : null}

      {route.name === "capture-launch" ? <CaptureLaunchScreen api={api} onBound={bound=>{setCaptureEngineSession(bound);go(`/proofs/${encodeURIComponent(bound.context.proofId)}/capture`);}} /> : null}
      {route.name === "station" ? (
        <PackingStationScreen
          authorizedEngineSession={captureEngineSession?.context.proofId===route.proofId?captureEngineSession:null}
          acceptedIntakeSnapshot={acceptedIntakeSnapshot?.proofId===route.proofId?acceptedIntakeSnapshot:null}
          onIntakeIntentConsumed={()=>setAcceptedIntakeSnapshot(null)}
          key={`${session.apiBaseUrl}:${session.userId}:${route.proofId || "queue"}`}
          api={api}
          userId={session.userId}
          queue={queue.filter(
            (item) =>
              item.workflowState !== "COMPLETED" &&
              item.workflowState !== "REMOVED_FROM_FULFILLMENT",
          )}
          error={error}
          initialReference={route.reference}
          initialProofId={route.proofId}
          onAuthExpired={signOut}
          onLeave={() => go(route.proofId ? `/proofs/${encodeURIComponent(route.proofId)}` : "/proofs")}
          onRecoverProof={(proofId) => go(`/proofs/${encodeURIComponent(proofId)}/capture`)}
          onCompleted={(proofId) => { proofIdRef.current = null; go(`/proofs/${encodeURIComponent(proofId)}`); }}
        />
      ) : null}

      {route.name === "stores" ? (
        <ConnectedStoresScreen
          intakeSettings={<IntakeSettingsPanel api={api} userId={session.userId} connections={connections} />}
          connectionPanel={<ConnectedAccountsPanel accounts={connectedAccounts} providers={connectedProviders} notice={connectedNotice} busy={busy}
            onConnect={(provider, extra) => { setBusy(true); void api.startConnectedAccountConnect(provider, extra).then(result => window.location.assign(result.authorizationUrl)).catch(caught => { setError(handleError(caught)); setBusy(false); }); }}
            onReauthorize={accountId => { setBusy(true); void api.reauthorizeConnectedAccount(accountId).then(result => window.location.assign(result.authorizationUrl)).catch(caught => { setError(handleError(caught)); setBusy(false); }); }}
            onDisconnect={accountId => { setBusy(true); void api.disconnectConnectedAccount(accountId).then(() => api.listConnectedAccounts()).then(result => { setConnectedAccounts(result.accounts); setConnectedProviders(result.providers); }).catch(caught => setError(handleError(caught))).finally(() => setBusy(false)); }} />}
          connections={connections}
          lastSync={lastSync}
          loading={loading}
          error={error}
          busy={busy}
          development={import.meta.env.DEV}
          ebay={ebay}
          onBack={() => goBack("/account")}
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
          onAutomation={(connectionId,enabled)=>{setBusy(true);setError(null);void api.setCommerceAutomation(connectionId,enabled).then(()=>api.listCommerceConnections()).then(result=>setConnections(result.connections)).catch(e=>setError(handleError(e))).finally(()=>setBusy(false));}}
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
          key={route.proofId}
          api={api}
          uploadProgress={uploadProgress}
          onRecoverCapture={() =>
            recoverCapture(captureQueueKey(session.userId, route.proofId, "PACKING"))
          }
          onOpenReceipt={() => go(`/receipt/${route.proofId}`)}
          onVerify={() => api.reviewProof(route.proofId)}
          onExport={async () => {
            const blob = await api.exportProofPackage(route.proofId);
            const url = URL.createObjectURL(blob),
              anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${route.proofId}.zip`;
            anchor.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
          proof={proof?.proofId === route.proofId ? proof : null}
          shipmentIntegrity={shipmentIntegrity}
          currentUserId={session.userId}
          loading={loading}
          error={error}
          busy={busy}
          development={import.meta.env.DEV}
          onBack={() => goBack("/")}
          onOpenInvite={() => go(`/proofs/${encodeURIComponent(route.proofId)}/invite`)}
          onOpenFinalize={() => go(`/proofs/${encodeURIComponent(route.proofId)}/finalize`)}
          onOpenEvent={(event) =>
            go(
              `/proofs/${encodeURIComponent(route.proofId)}/events/${encodeURIComponent(event.id)}`,
            )
          }
          onOpenStation={() => {
            const reference = proof?.transaction.externalReference || "";
            go(`/proofs/${encodeURIComponent(routeProofId(route) || "")}/capture?reference=${encodeURIComponent(reference)}`);
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
                idempotencyKey: randomId(),
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
                const evidenceId = await preserveCapture(
                  api,
                  session.userId,
                  proof.proofId,
                  row.slot,
                  row.file,
                  evidenceType,
                  setUploadProgress,
                );
                committed.push({ slot: row.slot, evidenceId });
              }
              setProof(await api.getProof(proof.proofId));
              return committed;
            } catch (caught) {
              setError(handleError(caught));
              throw caught;
            } finally {
              setBusy(false);
            }
          }}
          onLoadEvidence={loadProofEvidence}
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

      {route.name === "invite" ? (
        <InviteScreen
          proof={proof?.proofId === route.proofId ? proof : null}
          busy={busy}
          error={error}
          onBack={() => goBack(`/proofs/${encodeURIComponent(route.proofId)}`)}
          onSearchUsers={searchProofUsers}
          onInvite={inviteProofUser}
          onShare={() => {
            const title = proof?.transaction.itemTitle ?? "a PackProof";
            void navigator.clipboard.writeText(
              `You’ve been invited to a PackProof for ${title}. Open PackProof to review and join.`,
            );
          }}
        />
      ) : null}

      {route.name === "finalize" ? (
        <FinalizeScreen
          proof={proof?.proofId === route.proofId ? proof : null}
          busy={busy}
          error={error}
          onBack={() => goBack(`/proofs/${encodeURIComponent(route.proofId)}`)}
          requiresAttestation={Boolean(proof && proof.workflowType !== "GRADING_SUBMISSION" && !(proof.attestations || []).some(item => item.statement === "PACKED_DESCRIBED_ITEM" && item.attestedBy === session.userId))}
          onFinalize={() => {
            if (!proof) {
              return;
            }
            setBusy(true);
            const existing = proof.workflowType === "GRADING_SUBMISSION" || (proof.attestations || []).some(item => item.statement === "PACKED_DESCRIBED_ITEM" && item.attestedBy === session.userId);
            const prepare = existing ? Promise.resolve() : api.createAttestation(proof.proofId, { statement: "PACKED_DESCRIBED_ITEM", relatedEvidenceId: proof.evidence.find(item => item.validationStatus === "COMMITTED" && item.evidenceType === "FULFILLMENT_CAPTURE")?.evidenceId });
            void prepare.then(() => api.finalizeProof(proof.proofId))
              .then(async (result) => {
                proofIdRef.current = result.proof.proofId;
                setProof(result.proof);
                setShipmentIntegrity(await api.getShipmentIntegrity(result.proof.proofId));
                go(`/proofs/${encodeURIComponent(result.proof.proofId)}`);
              })
              .catch((caught) => setError(handleError(caught)))
              .finally(() => setBusy(false));
          }}
        />
      ) : null}

      {route.name === "event" ? (
        <EventDetailScreen
          event={proof?.chronology?.find((entry) => entry.id === route.eventId) ?? null}
          onBack={() => goBack(`/proofs/${encodeURIComponent(route.proofId)}`)}
        />
      ) : null}
    </div>
  );
}

export function App({ authInitialView }: { authInitialView?: "sign-in" | "create-account" } = {}) {
  retainCaptureLaunch();
  return (
    <ThemeProvider>
      <PackProofApp authInitialView={authInitialView} />
    </ThemeProvider>
  );
}
