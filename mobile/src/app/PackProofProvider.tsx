import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import {
  ApiError,
  PackProofV2Client,
  newIdempotencyKey,
  type ChronologyEntry,
  type IntegrationConnectionView,
  type InvitationInboxView,
  type ManifestView,
  type PackingStationResolveView,
  type ProfileView,
  type ProofCollectionItem,
  type ProofView,
  type PublicProfileView,
  type ShipmentIntegrityView,
  type TransactionImportView,
  type TransactionView,
} from "../v2-api";
import {
  cognitoConfirmForgotPassword,
  cognitoConfirmSignUp,
  cognitoForgotPassword,
  cognitoGlobalSignOut,
  cognitoRefresh,
  cognitoResendConfirmation,
  cognitoSignIn,
  cognitoSignUp,
  CognitoAuthError,
  formatCognitoError,
  type AuthMode,
  type CognitoConfig,
} from "../cognito";
import {
  describeLocalCapture,
  discardLocalCapture,
  localCaptureExists,
  recordPackingEvidence,
  uploadCaptureFile,
  type LocalCapture,
} from "../capture";
import { clearCachedState, loadCachedState, saveCachedState, type CachedClientState } from "../session";
import { resolveRuntimeConfig, shouldRestoreCachedSession, type ResolvedRuntimeConfig } from "../runtime-config";
import { EMPTY_FORM, formFromTransaction, parseContextForm, type ContextForm } from "../copy/forms";
import { formatUserFacingError, isNetworkFailure, toUserFacingError, type UserFacingError } from "../copy/errors";
import type { LocalCaptureStatus } from "../copy/status";
import type { AppRoute, AppRouteName, AuthPane, ProofDetailTab, ProofsFilter, TabId } from "./navigation";

const IS_RELEASE_CLIENT = !__DEV__;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MIN_LENGTH = 2;

function currentRuntime(cached?: {
  apiBaseUrl?: string | null;
  authMode?: AuthMode | null;
  cognitoUserPoolId?: string | null;
  cognitoClientId?: string | null;
  cognitoRegion?: string | null;
} | null): ResolvedRuntimeConfig {
  return resolveRuntimeConfig({
    env: {
      EXPO_PUBLIC_PACKPROOF_API_BASE_URL: process.env.EXPO_PUBLIC_PACKPROOF_API_BASE_URL,
      EXPO_PUBLIC_PACKPROOF_AUTH_MODE: process.env.EXPO_PUBLIC_PACKPROOF_AUTH_MODE,
      EXPO_PUBLIC_COGNITO_USER_POOL_ID: process.env.EXPO_PUBLIC_COGNITO_USER_POOL_ID,
      EXPO_PUBLIC_COGNITO_CLIENT_ID: process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID,
      EXPO_PUBLIC_COGNITO_REGION: process.env.EXPO_PUBLIC_COGNITO_REGION,
    },
    isRelease: IS_RELEASE_CLIENT,
    cached,
  });
}

const INITIAL_RUNTIME = currentRuntime();

function presentError(error: unknown): UserFacingError {
  if (error instanceof CognitoAuthError) {
    return {
      title: formatCognitoError(error),
      message: "",
      action: error.code === "UNAUTHENTICATED" ? "signin" : "none",
      technical: `${error.code}: ${error.message}`,
      code: error.code,
    };
  }
  return toUserFacingError(error);
}

export interface PackProofContextValue {
  hydrated: boolean;
  busy: boolean;
  offline: boolean;
  error: string | null;
  errorDetail: UserFacingError | null;
  route: AppRoute;
  tab: TabId;
  proofDetailTab: ProofDetailTab;
  proofsFilter: ProofsFilter;
  session: CachedClientState | null;
  proof: ProofView | null;
  transactionDetail: TransactionView | null;
  proofCollection: ProofCollectionItem[];
  pendingInvites: InvitationInboxView[];
  selectedInvite: InvitationInboxView | null;
  selectedEvent: ChronologyEntry | null;
  manifest: ManifestView | null;
  shipmentIntegrity: ShipmentIntegrityView | null;
  captureStatus: LocalCaptureStatus;
  localCapture: LocalCapture | null;
  uploadPercent: number | null;
  createForm: ContextForm;
  editForm: ContextForm;
  importReview: TransactionImportView | null;
  scanResult: PackingStationResolveView | null;
  scanInput: string;
  scanPhase: "camera" | "reference" | "found" | "missing";
  connections: IntegrationConnectionView[];
  authPane: AuthPane;
  authMode: AuthMode;
  apiBaseUrl: string;
  allowsApiOverride: boolean;
  allowsDevAuth: boolean;
  showCognitoSettings: boolean;
  cognitoPoolId: string;
  cognitoClientId: string;
  cognitoRegion: string;
  subject: string;
  email: string;
  password: string;
  newPassword: string;
  verificationCode: string;
  usernameInput: string;
  displayNameInput: string;
  searchQuery: string;
  searchResults: PublicProfileView[];
  searchStatus: "idle" | "loading" | "empty" | "ready" | "error";
  invitationInput: string;
  technicalOpen: boolean;
  confirmFinalize: boolean;
  client: PackProofV2Client;
  role: string | undefined;
  setTab: (tab: TabId) => void;
  go: (name: AppRouteName, extras?: Partial<AppRoute>) => void;
  goBack: () => void;
  setProofDetailTab: (tab: ProofDetailTab) => void;
  setProofsFilter: (filter: ProofsFilter) => void;
  setError: (value: string | null) => void;
  setAuthPane: (pane: AuthPane) => void;
  setAuthMode: (mode: AuthMode) => void;
  setApiBaseUrl: (value: string) => void;
  setShowCognitoSettings: (value: boolean | ((current: boolean) => boolean)) => void;
  setCognitoPoolId: (value: string) => void;
  setCognitoClientId: (value: string) => void;
  setCognitoRegion: (value: string) => void;
  setSubject: (value: string) => void;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  setNewPassword: (value: string) => void;
  setVerificationCode: (value: string) => void;
  setUsernameInput: (value: string) => void;
  setDisplayNameInput: (value: string) => void;
  setSearchQuery: (value: string) => void;
  setInvitationInput: (value: string) => void;
  setCreateForm: (form: ContextForm | ((current: ContextForm) => ContextForm)) => void;
  setEditForm: (form: ContextForm | ((current: ContextForm) => ContextForm)) => void;
  setScanInput: (value: string) => void;
  setScanPhase: (phase: "camera" | "reference" | "found" | "missing") => void;
  setTechnicalOpen: (value: boolean) => void;
  setConfirmFinalize: (value: boolean) => void;
  setSelectedEvent: (event: ChronologyEntry | null) => void;
  run: (action: () => Promise<void>) => Promise<void>;
  signIn: () => Promise<void>;
  createAccount: () => Promise<void>;
  verifyEmail: () => Promise<void>;
  resendVerification: () => Promise<void>;
  sendReset: () => Promise<void>;
  resetPassword: () => Promise<void>;
  signOut: () => Promise<void>;
  saveProfile: () => Promise<void>;
  syncWorkspace: () => Promise<void>;
  openProof: (proofId: string) => Promise<void>;
  refreshProof: (proofId: string) => Promise<ProofView>;
  importPurchase: () => Promise<void>;
  confirmImportedPurchase: () => Promise<void>;
  createManualProof: () => Promise<void>;
  identifyReference: (reference: string) => Promise<void>;
  continueFromScan: () => Promise<void>;
  savePurchaseDetails: () => Promise<void>;
  saveShippingDetails: () => Promise<void>;
  startCapture: () => Promise<void>;
  discardCapture: () => Promise<void>;
  submitCapture: () => Promise<void>;
  finalizeProof: () => Promise<void>;
  inviteUser: (userId: string) => Promise<void>;
  acceptInvite: (invitationId: string) => Promise<void>;
  openInvitation: (invite: InvitationInboxView) => void;
  importDemoShipment: (throughEventType?: string) => Promise<void>;
  syncShipment: () => Promise<void>;
  connectTrustedDemo: () => Promise<void>;
  loadConnections: () => Promise<void>;
  ensureAuth: () => Promise<void>;
  persistStation: (next: {
    capture: LocalCapture | null;
    evidenceIdempotencyKey: string | null;
    proofId: string | null;
    transactionId: string | null;
    orderLabel: string | null;
    itemSummary: string | null;
    stationActive: boolean;
  }) => Promise<void>;
}

const PackProofContext = createContext<PackProofContextValue | null>(null);

export function PackProofProvider(props: { children: ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [route, setRoute] = useState<AppRoute>({ name: "boot" });
  const [tab, setTabState] = useState<TabId>("home");
  const [proofDetailTab, setProofDetailTab] = useState<ProofDetailTab>("overview");
  const [proofsFilter, setProofsFilter] = useState<ProofsFilter>("active");
  const [authPane, setAuthPane] = useState<AuthPane>("signIn");
  const [apiBaseUrl, setApiBaseUrl] = useState(INITIAL_RUNTIME.apiBaseUrl);
  const [authMode, setAuthMode] = useState<AuthMode>(INITIAL_RUNTIME.authMode);
  const [showCognitoSettings, setShowCognitoSettings] = useState(false);
  const [cognitoPoolId, setCognitoPoolId] = useState(INITIAL_RUNTIME.cognito.userPoolId);
  const [cognitoClientId, setCognitoClientId] = useState(INITIAL_RUNTIME.cognito.clientId);
  const [cognitoRegion, setCognitoRegion] = useState(INITIAL_RUNTIME.cognito.region);
  const [subject, setSubject] = useState("seller-1");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PublicProfileView[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "empty" | "ready" | "error">("idle");
  const [pendingInvites, setPendingInvites] = useState<InvitationInboxView[]>([]);
  const [selectedInvite, setSelectedInvite] = useState<InvitationInboxView | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<ChronologyEntry | null>(null);
  const [proofCollection, setProofCollection] = useState<ProofCollectionItem[]>([]);
  const [invitationInput, setInvitationInput] = useState("");
  const [session, setSession] = useState<CachedClientState | null>(null);
  const [proof, setProof] = useState<ProofView | null>(null);
  const [transactionDetail, setTransactionDetail] = useState<TransactionView | null>(null);
  const [createForm, setCreateForm] = useState<ContextForm>(EMPTY_FORM);
  const [importReview, setImportReview] = useState<TransactionImportView | null>(null);
  const [editForm, setEditForm] = useState<ContextForm>(EMPTY_FORM);
  const [manifest, setManifest] = useState<ManifestView | null>(null);
  const [shipmentIntegrity, setShipmentIntegrity] = useState<ShipmentIntegrityView | null>(null);
  const [captureStatus, setCaptureStatus] = useState<LocalCaptureStatus>("idle");
  const [localCapture, setLocalCapture] = useState<LocalCapture | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [scanResult, setScanResult] = useState<PackingStationResolveView | null>(null);
  const [scanInput, setScanInput] = useState("");
  const [scanPhase, setScanPhase] = useState<"camera" | "reference" | "found" | "missing">("camera");
  const [connections, setConnections] = useState<IntegrationConnectionView[]>([]);
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<UserFacingError | null>(null);
  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const tokenRef = useRef<string | null>(null);
  const sessionRef = useRef<CachedClientState | null>(null);
  const searchGeneration = useRef(0);
  const tabRef = useRef<TabId>("home");

  const client = useMemo(
    () =>
      new PackProofV2Client({
        baseUrl: apiBaseUrl.trim(),
        getToken: () => tokenRef.current,
      }),
    [apiBaseUrl],
  );

  const go = useCallback((name: AppRouteName, extras?: Partial<AppRoute>) => {
    setError(null);
    if (name === "tabs" && extras?.tab) {
      tabRef.current = extras.tab;
      setTabState(extras.tab);
    }
    if (name === "scan") {
      setScanPhase("camera");
      setScanResult(null);
      setScanInput("");
    }
    if (name === "proof") {
      setProofDetailTab("overview");
      setTechnicalOpen(false);
      setConfirmFinalize(false);
    }
    setRoute({ name, tab: extras?.tab ?? tabRef.current });
  }, []);

  const setTab = useCallback(
    (next: TabId) => {
      tabRef.current = next;
      setTabState(next);
      go("tabs", { tab: next });
    },
    [go],
  );

  const goBack = useCallback(() => {
    if (route.name === "capture" || route.name === "finalize" || route.name === "invite" || route.name === "editPurchase" || route.name === "editShipping" || route.name === "event") {
      go("proof");
      return;
    }
    if (route.name === "complete") {
      go("proof");
      return;
    }
    if (route.name === "scan" || route.name === "manual" || route.name === "review") {
      go("tabs", { tab: "create" });
      return;
    }
    if (route.name === "invitation" || route.name === "dev" || route.name === "station" || route.name === "proof") {
      go("tabs", { tab: tabRef.current });
      return;
    }
    go("tabs", { tab: "home" });
  }, [go, route.name]);

  useEffect(() => {
    if (route.name !== "invite" || !proof || proof.status === "FINALIZED") {
      return;
    }
    const normalized = searchQuery.trim().replace(/^@+/, "").trim();
    if (normalized.length < SEARCH_MIN_LENGTH) {
      searchGeneration.current += 1;
      setSearchResults([]);
      setSearchStatus("idle");
      return;
    }
    const generation = ++searchGeneration.current;
    setSearchStatus("loading");
    const handle = setTimeout(() => {
      void client
        .searchProofUsers(proof.proofId, searchQuery.trim())
        .then((result) => {
          if (generation !== searchGeneration.current) {
            return;
          }
          setSearchResults(result.users);
          setSearchStatus(result.users.length > 0 ? "ready" : "empty");
        })
        .catch((caught) => {
          if (generation !== searchGeneration.current) {
            return;
          }
          setSearchStatus("error");
          setError(formatUserFacingError(caught));
          setErrorDetail(presentError(caught));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [client, proof, route.name, searchQuery]);

  function applyResolvedRuntime(runtime: ResolvedRuntimeConfig): void {
    setApiBaseUrl(runtime.apiBaseUrl);
    setAuthMode(runtime.authMode);
    setCognitoPoolId(runtime.cognito.userPoolId);
    setCognitoClientId(runtime.cognito.clientId);
    setCognitoRegion(runtime.cognito.region);
  }

  async function persist(next: CachedClientState): Promise<void> {
    const runtime = currentRuntime(IS_RELEASE_CLIENT ? null : next);
    const stored: CachedClientState = IS_RELEASE_CLIENT
      ? {
          ...next,
          apiBaseUrl: runtime.apiBaseUrl,
          authMode: "cognito",
          cognitoUserPoolId: runtime.cognito.userPoolId,
          cognitoClientId: runtime.cognito.clientId,
          cognitoRegion: runtime.cognito.region,
        }
      : next;
    tokenRef.current = stored.token;
    sessionRef.current = stored;
    setSession(stored);
    await saveCachedState(stored);
  }

  function requireCognitoConfig(): CognitoConfig {
    const config: CognitoConfig = {
      userPoolId: cognitoPoolId.trim(),
      clientId: cognitoClientId.trim(),
      region: cognitoRegion.trim() || "us-east-1",
    };
    if (!config.userPoolId || !config.clientId) {
      throw new Error("Cognito User Pool ID and app client ID are required");
    }
    return config;
  }

  async function applyProfile(profile: ProfileView): Promise<void> {
    const current = sessionRef.current;
    if (!current) {
      return;
    }
    await persist({
      ...current,
      userId: profile.userId,
      username: profile.username,
      displayName: profile.displayName,
    });
    setUsernameInput(profile.username ?? "");
    setDisplayNameInput(profile.displayName ?? "");
  }

  async function restoreAuthoritativeSession(cached: CachedClientState): Promise<CachedClientState | null> {
    let next = cached;
    if (cached.authMode === "cognito" && cached.refreshToken) {
      const needsRefresh = !cached.accessExpiresAt || cached.accessExpiresAt - Date.now() < 60_000;
      if (needsRefresh) {
        const refreshed = await cognitoRefresh(
          {
            userPoolId: cached.cognitoUserPoolId ?? cognitoPoolId,
            clientId: cached.cognitoClientId ?? cognitoClientId,
            region: cached.cognitoRegion ?? cognitoRegion,
          },
          cached.refreshToken,
        );
        next = {
          ...cached,
          token: refreshed.accessToken,
          idToken: refreshed.idToken,
          refreshToken: refreshed.refreshToken,
          accessExpiresAt: refreshed.expiresAt,
        };
        await persist(next);
      }
    }
    const api = new PackProofV2Client({
      baseUrl: next.apiBaseUrl,
      getToken: () => tokenRef.current,
    });
    const profile = await api.getMe();
    await applyProfile(profile);
    const inbox = await api.listInvitations();
    setPendingInvites(inbox.invitations);
    const collection = await api.listMyProofs();
    setProofCollection(collection.proofs);
    setOffline(false);
    return sessionRef.current;
  }

  async function establishSession(input: {
    token: string;
    subject: string;
    email?: string | null;
    refreshToken?: string | null;
    idToken?: string | null;
    accessExpiresAt?: number | null;
  }): Promise<ProfileView> {
    tokenRef.current = input.token;
    const profile = await client.getMe();
    const previous = sessionRef.current;
    const sameUser = previous?.userId === profile.userId;
    const next: CachedClientState = {
      apiBaseUrl: apiBaseUrl.trim(),
      authMode,
      subject: input.subject,
      email: input.email ?? null,
      userId: profile.userId,
      username: profile.username,
      displayName: profile.displayName,
      token: input.token,
      refreshToken: input.refreshToken ?? null,
      idToken: input.idToken ?? null,
      accessExpiresAt: input.accessExpiresAt ?? null,
      cognitoUserPoolId: authMode === "cognito" ? cognitoPoolId.trim() : null,
      cognitoClientId: authMode === "cognito" ? cognitoClientId.trim() : null,
      cognitoRegion: authMode === "cognito" ? cognitoRegion.trim() : null,
      proofId: sameUser ? previous?.proofId ?? null : null,
      transactionId: sameUser ? previous?.transactionId ?? null : null,
      invitationToken: sameUser ? previous?.invitationToken ?? null : null,
      captureUri: sameUser ? previous?.captureUri ?? null : null,
      evidenceIdempotencyKey: sameUser ? previous?.evidenceIdempotencyKey ?? null : null,
      evidenceContentType: sameUser ? previous?.evidenceContentType ?? null : null,
      captureByteSize: sameUser ? previous?.captureByteSize ?? null : null,
      captureDurationMs: sameUser ? previous?.captureDurationMs ?? null : null,
      stationActive: sameUser ? previous?.stationActive === true : false,
      stationPhase: sameUser ? previous?.stationPhase ?? null : null,
      stationProofId: sameUser ? previous?.stationProofId ?? null : null,
      stationTransactionId: sameUser ? previous?.stationTransactionId ?? null : null,
      stationOrderLabel: sameUser ? previous?.stationOrderLabel ?? null : null,
      stationItemSummary: sameUser ? previous?.stationItemSummary ?? null : null,
    };
    await persist(next);
    await applyProfile(profile);
    const inbox = await client.listInvitations();
    setPendingInvites(inbox.invitations);
    const collection = await client.listMyProofs();
    setProofCollection(collection.proofs);
    if (!sameUser) {
      setProof(null);
      setTransactionDetail(null);
      setLocalCapture(null);
      setCaptureStatus("idle");
      setUploadPercent(null);
      setCreateForm(EMPTY_FORM);
      setImportReview(null);
      setEditForm(EMPTY_FORM);
      setManifest(null);
      setSearchResults([]);
    }
    setOffline(false);
    return profile;
  }

  async function persistCapture(next: LocalCapture | null, idempotencyKey: string | null): Promise<void> {
    const current = sessionRef.current;
    if (!current) {
      return;
    }
    setLocalCapture(next);
    await persist({
      ...current,
      captureUri: next?.uri ?? null,
      evidenceIdempotencyKey: idempotencyKey,
      evidenceContentType: next?.contentType ?? null,
      captureByteSize: next?.byteSize ?? null,
      captureDurationMs: next?.durationMs ?? null,
    });
  }

  async function ensureFreshCognitoToken(): Promise<void> {
    const current = sessionRef.current;
    if (
      !current ||
      current.authMode !== "cognito" ||
      !current.refreshToken ||
      (current.accessExpiresAt && current.accessExpiresAt - Date.now() > 60_000)
    ) {
      return;
    }
    const refreshed = await cognitoRefresh(
      {
        userPoolId: current.cognitoUserPoolId ?? cognitoPoolId,
        clientId: current.cognitoClientId ?? cognitoClientId,
        region: current.cognitoRegion ?? cognitoRegion,
      },
      current.refreshToken,
    );
    await persist({
      ...current,
      token: refreshed.accessToken,
      idToken: refreshed.idToken,
      refreshToken: refreshed.refreshToken,
      accessExpiresAt: refreshed.expiresAt,
    });
  }

  async function refreshPendingInvites(): Promise<void> {
    const inbox = await client.listInvitations();
    setPendingInvites(inbox.invitations);
  }

  async function refreshProofCollection(): Promise<void> {
    const collection = await client.listMyProofs();
    setProofCollection(collection.proofs);
  }

  async function syncWorkspace(): Promise<void> {
    try {
      await ensureFreshCognitoToken();
      await refreshProofCollection();
      await refreshPendingInvites();
      setOffline(false);
    } catch (err) {
      if (isNetworkFailure(err)) {
        setOffline(true);
        return;
      }
      throw err;
    }
  }

  async function refreshProof(proofId: string): Promise<ProofView> {
    const fresh = await client.getProof(proofId);
    setProof(fresh);
    const txn = await client.getTransaction(fresh.transactionId);
    setTransactionDetail(txn);
    setEditForm(formFromTransaction(txn));
    if (fresh.status === "FINALIZED") {
      setManifest(await client.getManifest(proofId));
    } else {
      setManifest(null);
    }
    setShipmentIntegrity(await client.getShipmentIntegrity(proofId));
    const current = sessionRef.current;
    if (current) {
      await persist({ ...current, proofId: fresh.proofId, transactionId: fresh.transactionId });
    }
    setOffline(false);
    return fresh;
  }

  async function openProof(proofId: string): Promise<void> {
    const current = sessionRef.current;
    if (current) {
      await persist({ ...current, proofId });
    }
    await refreshProof(proofId);
    go("proof");
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    setErrorDetail(null);
    try {
      await ensureFreshCognitoToken();
      await action();
      setOffline(false);
    } catch (err) {
      if (isNetworkFailure(err)) {
        setOffline(true);
      }
      if (err instanceof ApiError && err.status === 401) {
        setAuthPane("signIn");
        go("auth");
      }
      const mapped = presentError(err);
      setErrorDetail(mapped);
      setError(mapped.message ? `${mapped.title} ${mapped.message}`.trim() : mapped.title);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const cached = await loadCachedState();
        if (!cached) {
          applyResolvedRuntime(currentRuntime());
          go("auth");
          return;
        }
        const runtime = currentRuntime(cached);
        applyResolvedRuntime(runtime);
        if (!shouldRestoreCachedSession(cached, IS_RELEASE_CLIENT)) {
          tokenRef.current = null;
          sessionRef.current = null;
          await clearCachedState();
          go("auth");
          return;
        }
        const next: CachedClientState = {
          ...cached,
          apiBaseUrl: runtime.apiBaseUrl,
          authMode: runtime.authMode,
          cognitoUserPoolId: runtime.cognito.userPoolId,
          cognitoClientId: runtime.cognito.clientId,
          cognitoRegion: runtime.cognito.region,
        };
        tokenRef.current = next.token;
        sessionRef.current = next;
        setSession(next);
        if (
          next.apiBaseUrl !== cached.apiBaseUrl ||
          next.authMode !== cached.authMode ||
          next.cognitoUserPoolId !== cached.cognitoUserPoolId ||
          next.cognitoClientId !== cached.cognitoClientId ||
          next.cognitoRegion !== cached.cognitoRegion
        ) {
          await saveCachedState(next);
        }
        setSubject(next.subject);
        setEmail(next.email ?? "");
        setUsernameInput(next.username ?? "");
        setDisplayNameInput(next.displayName ?? "");
        if (next.invitationToken) {
          setInvitationInput(next.invitationToken);
        }
        if (next.captureUri) {
          const restored = await describeLocalCapture(next.captureUri, {
            byteSize: next.captureByteSize,
            durationMs: next.captureDurationMs,
            contentType: next.evidenceContentType,
          });
          if (restored) {
            setLocalCapture(restored);
            setCaptureStatus(next.evidenceIdempotencyKey ? "retry" : "captured");
          } else {
            await persist({
              ...next,
              captureUri: null,
              evidenceIdempotencyKey: null,
              evidenceContentType: null,
              captureByteSize: null,
              captureDurationMs: null,
            });
            setCaptureStatus("idle");
            setError("Your recording was removed by the device. Record packing evidence again.");
          }
        }
        try {
          const restored = await restoreAuthoritativeSession(next);
          if (!restored) {
            go("auth");
            return;
          }
          go(next.stationActive ? "station" : "tabs", { tab: "home" });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) {
            const compiled = currentRuntime();
            tokenRef.current = null;
            sessionRef.current = null;
            await clearCachedState();
            setSession(null);
            applyResolvedRuntime(compiled);
            setAuthPane("signIn");
            go("auth");
            setError("Session expired. Sign in again.");
            return;
          }
          setError(formatUserFacingError(err));
          setErrorDetail(presentError(err));
          if (isNetworkFailure(err)) {
            setOffline(true);
          }
          go("tabs", { tab: "home" });
        }
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && sessionRef.current && route.name !== "capture" && route.name !== "station") {
        void syncWorkspace().catch(() => undefined);
      }
    });
    return () => sub.remove();
  }, [route.name]);

  async function finishSignIn(input: {
    token: string;
    subject: string;
    email?: string | null;
    refreshToken?: string | null;
    idToken?: string | null;
    accessExpiresAt?: number | null;
  }): Promise<void> {
    const profile = await establishSession(input);
    if (!profile.username && usernameInput.trim()) {
      const updated = await client.updateProfile({
        username: usernameInput.trim(),
        displayName: displayNameInput.trim() || usernameInput.trim(),
      });
      await applyProfile(updated);
    }
  }

  const role = proof?.participants.find((p) => p.userId === session?.userId)?.role;

  const value: PackProofContextValue = {
    hydrated,
    busy,
    offline,
    error,
    errorDetail,
    route,
    tab,
    proofDetailTab,
    proofsFilter,
    session,
    proof,
    transactionDetail,
    proofCollection,
    pendingInvites,
    selectedInvite,
    selectedEvent,
    manifest,
    shipmentIntegrity,
    captureStatus,
    localCapture,
    uploadPercent,
    createForm,
    editForm,
    importReview,
    scanResult,
    scanInput,
    scanPhase,
    connections,
    authPane,
    authMode,
    apiBaseUrl,
    allowsApiOverride: INITIAL_RUNTIME.allowsApiOverride,
    allowsDevAuth: INITIAL_RUNTIME.allowsDevAuth,
    showCognitoSettings,
    cognitoPoolId,
    cognitoClientId,
    cognitoRegion,
    subject,
    email,
    password,
    newPassword,
    verificationCode,
    usernameInput,
    displayNameInput,
    searchQuery,
    searchResults,
    searchStatus,
    invitationInput,
    technicalOpen,
    confirmFinalize,
    client,
    role,
    setTab,
    go,
    goBack,
    setProofDetailTab,
    setProofsFilter,
    setError,
    setAuthPane,
    setAuthMode,
    setApiBaseUrl,
    setShowCognitoSettings,
    setCognitoPoolId,
    setCognitoClientId,
    setCognitoRegion,
    setSubject,
    setEmail,
    setPassword,
    setNewPassword,
    setVerificationCode,
    setUsernameInput,
    setDisplayNameInput,
    setSearchQuery,
    setInvitationInput,
    setCreateForm,
    setEditForm,
    setScanInput,
    setScanPhase,
    setTechnicalOpen,
    setConfirmFinalize,
    setSelectedEvent,
    run,
    signIn: async () =>
      run(async () => {
        if (authMode === "dev") {
          const result = await client.login(subject.trim());
          await finishSignIn({ token: result.token, subject: subject.trim() });
        } else {
          const tokens = await cognitoSignIn(requireCognitoConfig(), { email: email.trim(), password });
          setPassword("");
          await finishSignIn({
            token: tokens.accessToken,
            subject: email.trim(),
            email: email.trim(),
            refreshToken: tokens.refreshToken,
            idToken: tokens.idToken,
            accessExpiresAt: tokens.expiresAt,
          });
        }
        go(sessionRef.current?.stationActive ? "station" : "tabs", { tab: "home" });
      }),
    createAccount: async () =>
      run(async () => {
        const created = await cognitoSignUp(requireCognitoConfig(), { email: email.trim(), password });
        setPassword("");
        setAuthPane(created.userConfirmed ? "signIn" : "verify");
      }),
    verifyEmail: async () =>
      run(async () => {
        await cognitoConfirmSignUp(requireCognitoConfig(), { email: email.trim(), code: verificationCode.trim() });
        setVerificationCode("");
        setAuthPane("signIn");
      }),
    resendVerification: async () =>
      run(async () => {
        await cognitoResendConfirmation(requireCognitoConfig(), email.trim());
      }),
    sendReset: async () =>
      run(async () => {
        await cognitoForgotPassword(requireCognitoConfig(), email.trim());
        setAuthPane("reset");
      }),
    resetPassword: async () =>
      run(async () => {
        await cognitoConfirmForgotPassword(requireCognitoConfig(), {
          email: email.trim(),
          code: verificationCode.trim(),
          password: newPassword,
        });
        setVerificationCode("");
        setNewPassword("");
        setAuthPane("signIn");
      }),
    signOut: async () =>
      run(async () => {
        const current = sessionRef.current;
        if (current?.authMode === "cognito" && current.token && current.cognitoClientId) {
          await cognitoGlobalSignOut(
            {
              userPoolId: current.cognitoUserPoolId ?? cognitoPoolId,
              clientId: current.cognitoClientId,
              region: current.cognitoRegion ?? cognitoRegion,
            },
            current.token,
          );
        }
        await discardLocalCapture(sessionRef.current?.captureUri);
        tokenRef.current = null;
        sessionRef.current = null;
        await clearCachedState();
        setSession(null);
        setProof(null);
        setTransactionDetail(null);
        setLocalCapture(null);
        setCaptureStatus("idle");
        setUploadPercent(null);
        setCreateForm(EMPTY_FORM);
        setImportReview(null);
        setEditForm(EMPTY_FORM);
        setManifest(null);
        setPendingInvites([]);
        setProofCollection([]);
        setSearchResults([]);
        setPassword("");
        applyResolvedRuntime(currentRuntime());
        setAuthPane("signIn");
        go("auth");
      }),
    saveProfile: async () =>
      run(async () => {
        const updated = await client.updateProfile(
          session?.username
            ? { displayName: displayNameInput.trim() }
            : { username: usernameInput.trim(), displayName: displayNameInput.trim() || usernameInput.trim() },
        );
        await applyProfile(updated);
      }),
    syncWorkspace,
    openProof,
    refreshProof,
    importPurchase: async () =>
      run(async () => {
        const imported = await client.importTransaction({ adapterKey: "demo-marketplace", createProof: false });
        setImportReview(imported);
        go("review");
      }),
    confirmImportedPurchase: async () =>
      run(async () => {
        if (!importReview || !sessionRef.current) {
          return;
        }
        const created = await client.createOrGetProof(importReview.transaction.transactionId);
        await persist({
          ...sessionRef.current,
          proofId: created.proofId,
          transactionId: created.transactionId,
        });
        await refreshProofCollection();
        await refreshProof(created.proofId);
        setImportReview(null);
        go("proof");
      }),
    createManualProof: async () =>
      run(async () => {
        if (!sessionRef.current) {
          return;
        }
        const parsed = parseContextForm(createForm);
        try {
          let transactionId = importReview?.transaction.transactionId ?? null;
          if (transactionId) {
            await client.updateTransaction(transactionId, { ...parsed.transaction });
            await client.updateShipping(transactionId, parsed.shipping);
          } else {
            const txn = await client.createTransaction({ ...parsed.transaction, shipping: parsed.shipping });
            transactionId = txn.transactionId;
          }
          const created = await client.createOrGetProof(transactionId);
          await persist({
            ...sessionRef.current,
            proofId: created.proofId,
            transactionId: created.transactionId,
          });
          await refreshProofCollection();
          await refreshProof(created.proofId);
          setCreateForm(EMPTY_FORM);
          setImportReview(null);
          go("proof");
        } catch (err) {
          const mapped = presentError(err);
          if (mapped.action === "open_existing") {
            const match = proofCollection.find(
              (item) =>
                (item.transaction.externalReference ?? "").trim().toLowerCase() ===
                createForm.externalReference.trim().toLowerCase(),
            );
            if (match) {
              await openProof(match.proofId);
              return;
            }
          }
          throw err;
        }
      }),
    identifyReference: async (reference: string) =>
      run(async () => {
        try {
          const resolved = await client.resolvePackingStation(reference);
          setScanResult(resolved);
          setScanPhase("found");
        } catch (err) {
          const mapped = presentError(err);
          if (mapped.code === "STATION_REFERENCE_NOT_FOUND" || mapped.code === "TRANSACTION_NOT_FOUND") {
            setScanResult(null);
            setScanPhase("missing");
            setError(mapped.title);
            setErrorDetail(mapped);
            return;
          }
          throw err;
        }
      }),
    continueFromScan: async () =>
      run(async () => {
        if (!scanResult || !sessionRef.current) {
          return;
        }
        const created = await client.createOrGetProof(scanResult.transactionId);
        await persist({
          ...sessionRef.current,
          proofId: created.proofId,
          transactionId: created.transactionId,
        });
        await refreshProofCollection();
        await refreshProof(created.proofId);
        go("proof");
      }),
    savePurchaseDetails: async () =>
      run(async () => {
        if (!proof) {
          return;
        }
        const parsed = parseContextForm(editForm);
        const updated = await client.updateTransaction(proof.transactionId, { ...parsed.transaction });
        setTransactionDetail(updated);
        setEditForm(formFromTransaction(updated));
        await refreshProof(proof.proofId);
        go("proof");
      }),
    saveShippingDetails: async () =>
      run(async () => {
        if (!proof) {
          return;
        }
        const parsed = parseContextForm(editForm);
        const updated = await client.updateShipping(proof.transactionId, parsed.shipping);
        setTransactionDetail(updated);
        setEditForm(formFromTransaction(updated));
        await refreshProof(proof.proofId);
        go("proof");
      }),
    startCapture: async () =>
      run(async () => {
        if (!proof) {
          return;
        }
        setCaptureStatus("capturing");
        const captured = await recordPackingEvidence();
        if (!captured) {
          setCaptureStatus(localCapture ? "captured" : "idle");
          return;
        }
        if (localCapture && localCapture.uri !== captured.uri) {
          await discardLocalCapture(localCapture.uri);
        }
        await persistCapture(captured, sessionRef.current?.evidenceIdempotencyKey ?? null);
        setCaptureStatus("captured");
        const fresh = await client.getProof(proof.proofId);
        setProof(fresh);
      }),
    discardCapture: async () =>
      run(async () => {
        if (!localCapture || !proof) {
          return;
        }
        await discardLocalCapture(localCapture.uri);
        await persistCapture(null, sessionRef.current?.evidenceIdempotencyKey ?? null);
        setCaptureStatus("idle");
        const fresh = await client.getProof(proof.proofId);
        setProof(fresh);
      }),
    submitCapture: async () =>
      run(async () => {
        if (!localCapture || !proof || !sessionRef.current) {
          return;
        }
        const available = await localCaptureExists(localCapture.uri);
        if (!available) {
          await persistCapture(null, null);
          setCaptureStatus("idle");
          throw new Error("Captured video is no longer available. Record packing evidence again.");
        }
        const key = sessionRef.current.evidenceIdempotencyKey ?? newIdempotencyKey();
        await persistCapture(localCapture, key);
        setCaptureStatus("uploading");
        setUploadPercent(0);
        try {
          const initialized = await client.initializeEvidenceUpload(proof.proofId, {
            contentType: localCapture.contentType,
            evidenceType: "FULFILLMENT_CAPTURE",
            idempotencyKey: key,
          });
          await uploadCaptureFile({
            baseUrl: apiBaseUrl.trim(),
            target: initialized.upload,
            fileUri: localCapture.uri,
            contentType: localCapture.contentType,
            onProgress: setUploadPercent,
          });
          setCaptureStatus("uploaded");
          await client.commitEvidence(proof.proofId, initialized.evidenceId);
          await discardLocalCapture(localCapture.uri);
          await persistCapture(null, null);
          setCaptureStatus("idle");
          setUploadPercent(null);
          await refreshProof(proof.proofId);
          go("proof");
        } catch (err) {
          setCaptureStatus("retry");
          throw err;
        }
      }),
    finalizeProof: async () =>
      run(async () => {
        if (!proof) {
          return;
        }
        const result = await client.finalizeProof(proof.proofId);
        setProof(result.proof);
        setManifest(result.manifest);
        await refreshProof(result.proof.proofId);
        await refreshProofCollection();
        setConfirmFinalize(false);
        go("complete");
      }),
    inviteUser: async (userId: string) =>
      run(async () => {
        if (!proof) {
          return;
        }
        await client.createInvitation(proof.proofId, { inviteeUserId: userId });
        setSearchResults((current) =>
          current.map((row) => (row.userId === userId ? { ...row, invitationState: "INVITED" } : row)),
        );
        await refreshProof(proof.proofId);
      }),
    acceptInvite: async (invitationId: string) =>
      run(async () => {
        if (!sessionRef.current) {
          return;
        }
        const accepted = await client.acceptInvitation(invitationId);
        await persist({
          ...sessionRef.current,
          proofId: accepted.proof.proofId,
          transactionId: accepted.proof.transactionId,
          invitationToken: null,
        });
        await refreshPendingInvites();
        await refreshProofCollection();
        await refreshProof(accepted.proof.proofId);
        setSelectedInvite(null);
        go("proof");
      }),
    openInvitation: (invite) => {
      setSelectedInvite(invite);
      go("invitation");
    },
    importDemoShipment: async (throughEventType?: string) =>
      run(async () => {
        if (!proof) {
          return;
        }
        await client.importShipmentEvents({
          adapterKey: "demo-carrier",
          transactionId: proof.transactionId,
          throughEventType: throughEventType ?? null,
        });
        await refreshProof(proof.proofId);
      }),
    syncShipment: async () =>
      run(async () => {
        if (!proof) {
          return;
        }
        await client.syncShipment(proof.transactionId);
        await refreshProof(proof.proofId);
      }),
    connectTrustedDemo: async () =>
      run(async () => {
        if (!proof) {
          return;
        }
        await client.connectTrustedDemo(proof.transactionId);
        await refreshProof(proof.proofId);
      }),
    loadConnections: async () =>
      run(async () => {
        const result = await client.listIntegrationConnections();
        setConnections(result.connections);
      }),
    ensureAuth: ensureFreshCognitoToken,
    persistStation: async (next) => {
      const current = sessionRef.current;
      if (!current) {
        return;
      }
      setLocalCapture(next.capture);
      await persist({
        ...current,
        captureUri: next.capture?.uri ?? null,
        evidenceIdempotencyKey: next.evidenceIdempotencyKey,
        evidenceContentType: next.capture?.contentType ?? null,
        captureByteSize: next.capture?.byteSize ?? null,
        captureDurationMs: next.capture?.durationMs ?? null,
        proofId: next.proofId ?? current.proofId,
        transactionId: next.transactionId ?? current.transactionId,
        stationActive: next.stationActive,
        stationPhase: next.stationActive ? "active" : null,
        stationProofId: next.proofId,
        stationTransactionId: next.transactionId,
        stationOrderLabel: next.orderLabel,
        stationItemSummary: next.itemSummary,
      });
    },
  };

  return <PackProofContext.Provider value={value}>{props.children}</PackProofContext.Provider>;
}

export function usePackProof(): PackProofContextValue {
  const value = useContext(PackProofContext);
  if (!value) {
    throw new Error("usePackProof must be used within PackProofProvider");
  }
  return value;
}
