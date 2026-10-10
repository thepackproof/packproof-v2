import { Onboarding } from "./onboarding/Onboarding";
import { useMobileTaskExperience } from "./mobile-task/useMobileTaskExperience";
import { MobileNavigation } from "./mobile-task/MobileNavigation";
import { MobileHomeScreen } from "./mobile-task/MobileHomeScreen";
import { MobilePackScreen } from "./mobile-task/MobilePackScreen";
import { MobileActivityScreen } from "./mobile-task/MobileActivityScreen";
import { mobileProofDestination, usableSavedRecording } from "./mobile-task/task-state";
import type { HomeAction } from "../../mobile/src/experience/task-home";
import { clearMobileUxMetrics, observeMobileDraftRoute, startMobileCaptureEntry } from "../../mobile/src/analytics/mobile-ux-events";
import "./mobile-task/mobile-task.css";
import {CaptureLaunchScreen,retainCaptureLaunch} from "./screens/CaptureLaunchScreen";
import { lazy, Suspense } from "react";
import { useAdminAccess } from "./admin/useAdminAccess";
const AdminWorkspace = lazy(() => import("./admin/AdminWorkspace"));
import { SubmissionIntakePanel } from "./components/SubmissionIntakePanel";
import { IntakeLinkFallback, IntakeSignInContext } from "./screens/IntakeLinkFallback";
import type {EngineSession} from "./capture/engine";
import { applyLocalWork } from "./proof-presentation";
import { listRecoverableRecordings } from "./capture-queue";
import { randomId } from "./random-id";
import { LocalRecordingRecovery } from "./components/LocalRecordingRecovery";
import { clearViewState, saveNavigationContext, setNavigationScope } from "./navigation-context";
import { ConnectedAccountsPanel } from "./screens/ConnectedAccountsPanel";
import { preserveCapture, recoverCapture, captureQueueKey } from "./capture-queue";
import { ProofsScreen } from "./screens/ProofsScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { OrdersScreen } from "./screens/OrdersScreen";
import { UploadsScreen } from "./screens/UploadsScreen";
import { NotificationsScreen } from "./screens/NotificationsScreen";
import { WorkstationHeader } from "./components/WorkstationHeader";
import type { LocalRecordingSummary } from "./capture-queue";
import { canonicalWorkspacePath, readProofListState, rememberProofListState } from "./proof-list-state";
import { ReceiptScreen } from "./screens/ReceiptScreen";
import { DeveloperScreen } from "./screens/DeveloperScreen";
import { useDeveloperAccess } from "./auth/useDeveloperAccess";
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
  | { name: "home" }
  | { name: "pack" }
  | { name: "fulfillment" }
  | { name: "uploads" }
  | { name: "activity" }
  | { name: "admin" }
  | { name: "proofs"; view: "all" | "attention" | "completed"; query: string }
  | { name: "capture-launch" }
  | { name: "intake-handoff" }
  | { name: "create"; reference?: string }
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
  | { name: "station"; reference?: string; proofId?: string; tools?: boolean }
  | { name: "stores" }
  | { name: "privacy" }
  | { name: "terms" }
  | { name: "public"; token: string };

function parseHref(href: string): Route {
  const url = new URL(canonicalWorkspacePath(href), "http://packproof.local");
  const pathname = url.pathname.replace(/\/$/, "") || "/";
  if (pathname === "/app") return { name: "home" };
  if (pathname === "/pack") return { name: "pack" };
  if (pathname === "/fulfillment") return { name: "fulfillment" };
  if (pathname === "/uploads") return { name: "uploads" };
  if (pathname === "/activity") return { name: "activity" };
  if (pathname === "/station") return { name: "station", tools: url.searchParams.get("tools") === "1" || url.hash.startsWith("#relay="), reference: url.searchParams.get("reference") || undefined };
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return {name:"admin"};
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
    return { name: "create", reference: url.searchParams.get("reference")?.slice(0, 200) || undefined };
  }
  if (pathname === "/proofs") {
    return { name: "proofs", ...readProofListState(url) };
  }
  if (pathname === "/capture") return {name:"capture-launch"};
  if (/^\/app\/capture\/[A-Za-z0-9_-]{1,160}$/.test(pathname)) return { name: "intake-handoff" };
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
  return { name: "proofs", view: "attention", query: "" };
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
    name === "home" || name === "pack" || name === "fulfillment" || name === "uploads" || name === "activity" ||
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
  const mobileTask = useMobileTaskExperience();
  const [captureActive, setCaptureActive] = useState(false);
  const [homeProofs, setHomeProofs] = useState<ProofCollectionItem[]>([]);
  const [homeRefreshedAt, setHomeRefreshedAt] = useState<string | null>(null);
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  const taskPending = useRef(false);
  const [taskSelection, setTaskSelection] = useState<string | undefined>();
  const [taskInteractions, setTaskInteractions] = useState<Record<string, number>>({});
  const [enteredFromIntakeLink] = useState(() => window.location.pathname.startsWith("/app/"));
  const adminLanding = useRef(window.location.pathname === "/login");
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
  const [recordings, setRecordings] = useState<LocalRecordingSummary[]>([]);
  const [recordingsLoaded, setRecordingsLoaded] = useState(false);
  const onRecordingsChange = useCallback((items: LocalRecordingSummary[]) => { setRecordings(items); setRecordingsLoaded(true); }, []);
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
    clearMobileUxMetrics();
    setHomeProofs([]); setHomeRefreshedAt(null); setTaskSelection(undefined); setTaskNotice(null);
    try { setTaskInteractions(session ? JSON.parse(sessionStorage.getItem(`packproof.view.${session.apiBaseUrl}.${session.userId}.task-interactions`) || "{}") : {}); }
    catch { setTaskInteractions({}); }
  }, [session?.userId, session?.apiBaseUrl]);

  useEffect(() => {
    if (!mobileTask || !session) return;
    observeMobileDraftRoute(["create", "scan", "intake-handoff"].includes(route.name) ? "draft" : ["station", "capture-launch"].includes(route.name) ? "capture" : "other");
  }, [mobileTask, route.name, session?.userId, session?.apiBaseUrl]);

  useEffect(() => {
    if (!mobileTask || !captureActive) return;
    const path = window.location.pathname + window.location.search, state = window.history.state;
    const protect = (event: PopStateEvent) => { event.stopImmediatePropagation(); window.history.pushState(state, "", path); setTaskNotice("Finish recording to save your footage before leaving capture."); };
    window.addEventListener("popstate", protect, true);
    return () => window.removeEventListener("popstate", protect, true);
  }, [mobileTask, captureActive]);

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
  const developerAllowed = useDeveloperAccess(api, session?.userId ?? "", route.name === "account" || route.name === "developer");
  const adminAccess = useAdminAccess(api, session?.userId ?? "");
  useEffect(() => {
    const version = import.meta.env.VITE_PACKPROOF_WEB_VERSION;
    if (!session?.userId || !import.meta.env.PROD || !version) return;
    const report = () => {
      if (document.visibilityState !== "visible") return;
      void api.reportClientVersion({ platform: "WEB", version, ...(import.meta.env.VITE_PACKPROOF_WEB_BUILD ? { build: import.meta.env.VITE_PACKPROOF_WEB_BUILD } : {}) }).catch(() => {});
    };
    report();
    const timer = window.setInterval(report, 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [api, session?.userId]);
  useEffect(() => {
    if (!session || adminAccess.loading || !adminLanding.current) return;
    adminLanding.current = false;
    if (adminAccess.allowed) go("/admin");
  }, [adminAccess.allowed, adminAccess.loading, session?.userId]);

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
    setHomeProofs([]); setHomeRefreshedAt(null); setTaskNotice(null); setTaskSelection(undefined); setTaskInteractions({}); setCaptureActive(false);
    setAcceptedIntakeSnapshot(null);
    sessionRef.current = null;
    tokenRef.current = null;
    clearSession();
    clearViewState();
    setSession(null);
    setProofs([]);
    setQueue([]);
    setRecordings([]);
    setRecordingsLoaded(false);
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
    setRoute({ name: "proofs", view: "attention", query: "" });
  }

  function go(path: string) {
    if (captureActive && mobileTask) { setTaskNotice("Finish recording to save your footage before leaving capture."); return; }
    if (mobileTask && (path === "/new" || path.startsWith("/new?") || path.endsWith("/capture"))) startMobileCaptureEntry();
    if (path === "/" && !isLegalRoute(route)) path = "/app";
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

  async function openMobileTask(target: string | ProofCollectionItem | HomeAction, preferredRecording?: LocalRecordingSummary) {
    if (!session || taskPending.current) return;
    if (typeof target !== "string" && "kind" in target && target.kind === "create_proof") { go("/new"); return; }
    const id = typeof target === "string" ? target : "proofId" in target ? target.proofId : target.targetId;
    if (!id) return;
    const summary = typeof target !== "string" && "proofId" in target ? target : homeProofs.find(row => row.proofId === id) || proofs.find(row => row.proofId === id);
    if (summary?.accessKind === "RECEIVER") { go(`/receipt/${encodeURIComponent(id)}`); return; }
    if (summary?.invitationId) { go(`/invitations/${encodeURIComponent(summary.invitationId)}`); return; }
    taskPending.current = true; setTaskBusy(true); setTaskNotice(null);
    const account = session.userId, scope = session.apiBaseUrl, path = window.location.pathname + window.location.search;
    const current = () => sessionRef.current?.userId === account && sessionRef.current?.apiBaseUrl === scope && path === window.location.pathname + window.location.search;
    try {
      const local = await listRecoverableRecordings(account, api);
      if (!current()) return;
      const recording = local.find(row => row.proofId === id && !row.finalized && !row.submitted && (!preferredRecording || row.key === preferredRecording.key));
      if (navigator.onLine === false) {
        if (recording?.kind === "station" && !recording.accepted && recording.available && await usableSavedRecording(recording.file)) {
          if (current()) { setTaskNotice("Reviewing evidence saved on this device. Connect to check server requirements before submitting."); go(`/proofs/${encodeURIComponent(id)}/capture`); }
        } else setTaskNotice("Connect to check this Proof’s next step. Your saved recording remains on this device.");
        return;
      }
      const fresh = await api.getProof(id);
      if (!current()) return;
      const destination = mobileProofDestination(fresh, account, recording);
      if (fresh.status === "FINALIZED" && fresh.finalizedAt) setTaskNotice("This Proof is already finalized. Its current record is ready to view.");
      const interactions = { ...taskInteractions, [id]: Date.now() };
      setTaskSelection(id); setTaskInteractions(interactions);
      try { sessionStorage.setItem(`packproof.view.${scope}.${account}.task-interactions`, JSON.stringify(interactions)); } catch { /* Session ranking remains usable without storage. */ }
      go(destination);
    } catch (caught) { if (current()) setTaskNotice(handleError(caught)); }
    finally { taskPending.current = false; setTaskBusy(false); }
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
    if (route.name === "home" && mobileTask) {
      setLoading(true); setError(null);
      void Promise.allSettled([api.listProofs({ view: "all" }), api.listFulfillmentQueue(), api.listInvitations(), listRecoverableRecordings(session.userId, api)])
        .then(([listed, orders, inbox, local]) => {
          if (cancelled) return;
          if (local.status === "fulfilled") { setRecordings(local.value); setRecordingsLoaded(true); }
          if (listed.status === "fulfilled") { setHomeProofs(listed.value.proofs); setHomeRefreshedAt(new Date().toISOString()); }
          else fail(listed.reason);
          if (orders.status === "fulfilled") setQueue(orders.value.items);
          if (inbox.status === "fulfilled") setInvitations(inbox.value.invitations);
        }).finally(finished);
    }
    if (route.name === "home" && !mobileTask) {
      setLoading(true);
      setError(null);
      setRecordingsLoaded(false);
      void Promise.all([api.listProofs({ view: "all" }), api.listFulfillmentQueue(), api.listCommerceConnections(), api.listInvitations(), listRecoverableRecordings(session.userId, api).catch(() => null)])
        .then(([listed, orders, commerce, inbox, local]) => {
          if (cancelled) return;
          setProofs(listed.proofs.map(item => applyLocalWork(item, local?.find(recording => recording.proofId === item.proofId))));
          setQueue(orders.items);
          setConnections(commerce.connections);
          setInvitations(inbox.invitations);
          setRecordings(local ?? []);
          setRecordingsLoaded(local !== null);
        }).catch(fail).finally(finished);
    }
    if (route.name === "fulfillment") {
      setLoading(true);
      setError(null);
      void Promise.all([api.listFulfillmentQueue("all"), api.listCommerceConnections()])
        .then(([orders, commerce]) => { if (!cancelled) { setQueue(orders.items); setConnections(commerce.connections); } })
        .catch(fail).finally(finished);
    }
    if (route.name === "uploads") {
      setLoading(true);
      setError(null);
      setRecordingsLoaded(false);
      void listRecoverableRecordings(session.userId, api)
        .then(local => { if (!cancelled) { setRecordings(local); setRecordingsLoaded(true); } })
        .catch(fail).finally(finished);
    }
    if (route.name === "activity") {
      setLoading(true);
      setError(null);
      void api.listInvitations().then(inbox => { if (!cancelled) setInvitations(inbox.invitations); }).catch(fail).finally(finished);
      if (mobileTask) void listRecoverableRecordings(session.userId, api).then(local => { if (!cancelled) { setRecordings(local); setRecordingsLoaded(true); } }).catch(fail);
    }
    if (route.name === "proofs") {
      setLoading(true);
      setError(null);
      rememberProofListState(`${session.apiBaseUrl}.${session.userId}`, { view: route.view, query: route.query });
      void Promise.all([api.listProofs({ view: "all", q: route.query }), listRecoverableRecordings(session.userId, api).catch(() => [])])
        .then(([listed, local]) => {
          if (cancelled) return;
          const rows = listed.proofs.map(item => applyLocalWork(item, local.find(recording => recording.proofId === item.proofId)));
          const visible = rows.filter(item => route.view === "all" || (route.view === "attention" ? item.presentation.needsAttention || mobileTask && !!item.presentation.diagnostic : item.presentation.completed));
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
    if (route.name === "station" || route.name === "pack") {
      setLoading(true);
      void api.listFulfillmentQueue().then(orders => { if (!cancelled) setQueue(orders.items); }).catch(fail).finally(finished);
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
  }, [api, route, session?.userId, session?.username, session?.displayName, listRetry, mobileTask]);

  useEffect(() => {
    if (route.name !== "home" || !session) return;
    const refresh = () => setListRetry(value => value + 1);
    window.addEventListener("packproof:records-updated", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("packproof:records-updated", refresh); window.removeEventListener("online", refresh); window.removeEventListener("focus", refresh); };
  }, [route.name, session?.userId]);

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
        {enteredFromIntakeLink ? <IntakeSignInContext /> : null}
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
            else if (["/login", "/signup", "/"].includes(window.location.pathname)) go("/app");
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
    onRetry: () => { setError(null); setListRetry(value => value + 1); },
    onOpenProof: (proofId: string) => go(`/proofs/${encodeURIComponent(proofId)}`),
    onCreate: () => go("/new"),
    onOpenReceiver: (proofId: string) => go(`/receipt/${encodeURIComponent(proofId)}`),
    onOpenInvitation: (invitationId: string) => go(`/invitations/${encodeURIComponent(invitationId)}`),
  };

  if (route.name === "admin") return <Suspense fallback={<main className="app-loading" role="status">Opening administration…</main>}><AdminWorkspace api={api} access={adminAccess} accountName={session.displayName || session.username || "Administrator"} onGo={go} onSignOut={signOut} /></Suspense>;

  return (
    <div className={`app-shell workspace-shell${mobileTask ? " mobile-task-shell" : ""}${captureActive ? " capture-active" : ""}`}>
      <Onboarding key={`${session.apiBaseUrl}:${session.userId}`} api={api} accountKey={`${session.apiBaseUrl}:${session.userId}`} dashboard={route.name==='proofs'} ready={!busy} onDashboard={()=>go('/proofs')} onCreate={()=>go('/new')} onViewProof={id=>go(`/proofs/${encodeURIComponent(id)}`)} capture={route.name==='station'} />
        {(route.name==='proofs'||route.name==='create')&&<CompanionBridge api={api} userId={session.userId} connections={connections}/>}
        {route.name==='proof'&&proof?.status==='READY_FOR_EVIDENCE'&&proof.workflowType==='COMMERCE_SALE'&&proof.participationPolicy==='COUNTERPARTY_OPTIONAL'&&<SelectedOrderHandoff key={proof.proofId} api={api} userId={session.userId} transactionId={proof.transaction.transactionId}/>}
        {mobileTask ? (!captureActive && <MobileNavigation session={session} route={route.name} adminAllowed={adminAccess.allowed} onGo={go} onSignOut={signOut} />) : <AppNav
          adminAllowed={adminAccess.allowed}
          session={session}
          invitationCount={invitations.length}
          currentRoute={route.name}
          onGo={go}
          onGoHome={() => go("/")}
          onOpenAccount={() => go("/account")}
          onSignOut={signOut}
        />}
      {!mobileTask && <WorkstationHeader route={route.name} refreshing={loading || busy} onRefresh={libraryProps.onRetry} />}
      {mobileTask && taskNotice && route.name !== "home" && <p className="task-notice" role="status">{taskNotice}</p>}

      {route.name === "home" && (mobileTask ? <MobileHomeScreen proofs={homeProofs} recordings={recordings} recordingsLoaded={recordingsLoaded} queue={queue} loading={loading} error={error} refreshedAt={homeRefreshedAt} busy={taskBusy} notice={taskNotice} selection={taskSelection} interactions={taskInteractions} onGo={go} onRetry={libraryProps.onRetry} onAction={action => void openMobileTask(action)} onOpen={item => void openMobileTask(item)} /> : <HomeScreen api={api} proofs={proofs} queue={queue} connections={connections} loading={loading} error={error} pendingUploadCount={recordingsLoaded ? recordings.filter(item => !(item.finalized && item.preserved)).length : undefined} onRetry={libraryProps.onRetry} onGo={go} onOpenProof={libraryProps.onOpenProof} onOpenInvitation={libraryProps.onOpenInvitation} onOpenReceiver={libraryProps.onOpenReceiver} />)}
      {(route.name === "pack" || mobileTask && route.name === "station" && !route.proofId && !route.reference && !route.tools && !recordings.some(row => row.kind === "station" && !row.finalized)) && <MobilePackScreen api={api} queue={queue} loading={loading} error={error} onRetry={libraryProps.onRetry} onGo={go} onOpen={id => void openMobileTask(id)} onCreate={reference => go(reference ? `/new?reference=${encodeURIComponent(reference)}` : "/new")} />}
      {route.name === "fulfillment" && <OrdersScreen orders={queue} loading={loading} error={error} syncBusy={busy} syncAvailable={connections.some(item => item.status === "ACTIVE")} onRetry={libraryProps.onRetry} onOpenProof={libraryProps.onOpenProof} onOpenStation={id => go(`/proofs/${encodeURIComponent(id)}/capture`)} onOpenIntegrations={() => go("/stores")} onCreate={libraryProps.onCreate} onSync={async () => {
        setBusy(true); setError(null);
        try { for (const connection of connections.filter(item => item.status === "ACTIVE")) setLastSync(await api.syncCommerceConnection(connection.connectionId)); setListRetry(value => value + 1); }
        catch (caught) { setError(handleError(caught)); }
        finally { setBusy(false); }
      }} />}
      {mobileTask && (route.name === "activity" || route.name === "uploads") && <MobileActivityScreen api={api} userId={session.userId} recordings={recordings} recordingsLoaded={recordingsLoaded} invitations={invitations} error={error} onRefresh={libraryProps.onRetry} onChange={onRecordingsChange} onOpen={(id, recording) => recording?.accepted ? libraryProps.onOpenProof(id) : void openMobileTask(id, recording)} onInvitation={libraryProps.onOpenInvitation} onCreate={libraryProps.onCreate} />}
      {!mobileTask && route.name === "uploads" && <UploadsScreen recordings={recordings} loading={loading} error={error} onRefresh={libraryProps.onRetry} onOpenStation={() => go(mobileTask ? "/station?tools=1" : "/station")} />}
      {!mobileTask && route.name === "activity" && <NotificationsScreen invitations={invitations} loading={loading} error={error} onRetry={libraryProps.onRetry} onOpenInvitation={libraryProps.onOpenInvitation} />}
      <LocalRecordingRecovery visible={route.name === "account" || route.name === "uploads"} key={session.userId} api={api} userId={session.userId} onRecordingsChange={onRecordingsChange} onOpen={id => go(`/proofs/${encodeURIComponent(id)}`)} />

      {route.name === "proofs" ? <ProofsScreen api={api} {...libraryProps} mobileTask={mobileTask} taskBusy={taskBusy} onNextTask={item => void openMobileTask(item)} readyOrders={!mobileTask && <ReadyIntakeOrders api={api} userId={session.userId} onRecord={snapshot=>{setAcceptedIntakeSnapshot(snapshot);go(`/proofs/${encodeURIComponent(snapshot.proofId)}/capture`);}} />} /> : null}

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
        developerAllowed ? <DeveloperScreen key={`${session.apiBaseUrl}:${session.userId}`} api={api} onBack={() => goBack("/account")} />
          : <div className="card"><p>Developer access is unavailable for this account or could not be confirmed.</p><button className="btn btn-secondary" onClick={() => goBack("/account")}>Back to account</button></div>
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
          onOpenDeveloper={developerAllowed ? () => go("/developer") : undefined}
          onOpenStation={() => go(mobileTask ? "/station?tools=1" : "/station")}
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
              .then(() => Promise.all([api.listConnectedAccounts(), api.listCommerceConnections(), api.listMarketplaces()]))
              .then(([listed, commerce, marketplaces]) => {
                setEbay(pickEbay(marketplaces));
                setConnections(commerce.connections);
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
          initialReference={route.reference}
          readyOrders={<ReadyIntakeOrders api={api} userId={session.userId} onRecord={snapshot=>{setAcceptedIntakeSnapshot(snapshot);go(`/proofs/${encodeURIComponent(snapshot.proofId)}/capture`);}} />}
          onPreviewIntake={(text) => api.previewOrderIntake(text)}
          renderIntakePanel={onReview => <SubmissionIntakePanel key={`${session.apiBaseUrl}:${session.userId}`} api={api} userId={session.userId} onPreview={text => api.previewOrderIntake(text)} onReview={onReview} onOpenProof={id => go(`/proofs/${encodeURIComponent(id)}`)} />}
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
      {route.name === "intake-handoff" ? <IntakeLinkFallback onQueue={() => go("/proofs?filter=attention")} /> : null}
      {route.name === "station" && !(mobileTask && !route.proofId && !route.reference && !route.tools && !recordings.some(row => row.kind === "station" && !row.finalized)) ? (
        <PackingStationScreen
          onCaptureActive={setCaptureActive}
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
          onCreate={libraryProps.onCreate}
          intakeSettings={<IntakeSettingsPanel api={api} userId={session.userId} connections={connections} />}
          connectionPanel={<ConnectedAccountsPanel accounts={connectedAccounts} providers={connectedProviders} notice={connectedNotice} busy={busy}
            onConnect={(provider, extra) => { setBusy(true); void api.startConnectedAccountConnect(provider, extra).then(result => window.location.assign(result.authorizationUrl)).catch(caught => { setError(handleError(caught)); setBusy(false); }); }}
            onReauthorize={accountId => { setBusy(true); void api.reauthorizeConnectedAccount(accountId).then(result => window.location.assign(result.authorizationUrl)).catch(caught => { setError(handleError(caught)); setBusy(false); }); }}
            onDisconnect={accountId => { setBusy(true); void api.disconnectConnectedAccount(accountId).then(() => Promise.all([api.listConnectedAccounts(), api.listCommerceConnections(), api.listMarketplaces()])).then(([result, commerce, marketplaces]) => { setEbay(pickEbay(marketplaces)); setConnectedAccounts(result.accounts); setConnectedProviders(result.providers); setConnections(commerce.connections); }).catch(caught => setError(handleError(caught))).finally(() => setBusy(false)); }} />}
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
      <footer className="workstation-footer"><span>PackProof Web</span><span>Neutral evidence. Source-linked records.</span></footer>
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
