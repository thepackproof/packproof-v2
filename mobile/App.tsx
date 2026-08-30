import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  ApiError,
  PackProofV2Client,
  newIdempotencyKey,
  type InvitationInboxView,
  type ManifestView,
  type ProfileView,
  type ProofCollectionItem,
  type ProofView,
  type PublicProfileView,
  type TransactionView,
} from "./src/v2-api";
import {
  cognitoConfirmForgotPassword,
  cognitoConfirmSignUp,
  cognitoForgotPassword,
  cognitoGlobalSignOut,
  cognitoRefresh,
  cognitoResendConfirmation,
  cognitoSignIn,
  cognitoSignUp,
  defaultAuthMode,
  defaultCognitoConfig,
  CognitoAuthError,
  formatCognitoError,
  type AuthMode,
  type CognitoConfig,
} from "./src/cognito";
import {
  describeLocalCapture,
  discardLocalCapture,
  formatBytes,
  formatDuration,
  localCaptureExists,
  recordPackingEvidence,
  uploadCaptureFile,
  type LocalCapture,
} from "./src/capture";
import {
  clearCachedState,
  loadCachedState,
  saveCachedState,
  type CachedClientState,
} from "./src/session";

type Screen = "auth" | "home" | "proof" | "capture";
type AuthPane = "signIn" | "createAccount" | "verify" | "forgot" | "reset";
type LocalCaptureStatus = "idle" | "capturing" | "captured" | "uploading" | "uploaded" | "retry";

const DEFAULT_API = "http://127.0.0.1:3000";

interface ContextForm {
  externalReference: string;
  transactionDate: string;
  itemTitle: string;
  itemDescription: string;
  quantity: string;
  transactionValue: string;
  currency: string;
  carrier: string;
  service: string;
  trackingNumber: string;
  shipmentDate: string;
}

const EMPTY_FORM: ContextForm = {
  externalReference: "",
  transactionDate: "",
  itemTitle: "",
  itemDescription: "",
  quantity: "",
  transactionValue: "",
  currency: "",
  carrier: "",
  service: "",
  trackingNumber: "",
  shipmentDate: "",
};

export default function App() {
  const [screen, setScreen] = useState<Screen>("auth");
  const [authPane, setAuthPane] = useState<AuthPane>("signIn");
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API);
  const [authMode, setAuthMode] = useState<AuthMode>(defaultAuthMode);
  const [showCognitoSettings, setShowCognitoSettings] = useState(false);
  const [cognitoPoolId, setCognitoPoolId] = useState(defaultCognitoConfig().userPoolId);
  const [cognitoClientId, setCognitoClientId] = useState(defaultCognitoConfig().clientId);
  const [cognitoRegion, setCognitoRegion] = useState(defaultCognitoConfig().region);
  const [subject, setSubject] = useState("seller-1");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [usernameInput, setUsernameInput] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PublicProfileView[]>([]);
  const [selectedBuyer, setSelectedBuyer] = useState<PublicProfileView | null>(null);
  const [pendingInvites, setPendingInvites] = useState<InvitationInboxView[]>([]);
  const [proofCollection, setProofCollection] = useState<ProofCollectionItem[]>([]);
  const [inviteeIdentifier, setInviteeIdentifier] = useState("");
  const [invitationInput, setInvitationInput] = useState("");
  const [session, setSession] = useState<CachedClientState | null>(null);
  const [proof, setProof] = useState<ProofView | null>(null);
  const [transactionDetail, setTransactionDetail] = useState<TransactionView | null>(null);
  const [createForm, setCreateForm] = useState<ContextForm>(EMPTY_FORM);
  const [editForm, setEditForm] = useState<ContextForm>(EMPTY_FORM);
  const [manifest, setManifest] = useState<ManifestView | null>(null);
  const [captureStatus, setCaptureStatus] = useState<LocalCaptureStatus>("idle");
  const [localCapture, setLocalCapture] = useState<LocalCapture | null>(null);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(null);
  const sessionRef = useRef<CachedClientState | null>(null);

  const client = useMemo(
    () =>
      new PackProofV2Client({
        baseUrl: apiBaseUrl.trim(),
        getToken: () => tokenRef.current,
      }),
    [apiBaseUrl],
  );

  useEffect(() => {
    void (async () => {
      const cached = await loadCachedState();
      if (!cached) {
        return;
      }
      tokenRef.current = cached.token;
      sessionRef.current = cached;
      setSession(cached);
      setApiBaseUrl(cached.apiBaseUrl);
      setAuthMode(cached.authMode);
      setSubject(cached.subject);
      setEmail(cached.email ?? "");
      setUsernameInput(cached.username ?? "");
      setDisplayNameInput(cached.displayName ?? "");
      if (cached.cognitoUserPoolId) {
        setCognitoPoolId(cached.cognitoUserPoolId);
      }
      if (cached.cognitoClientId) {
        setCognitoClientId(cached.cognitoClientId);
      }
      if (cached.cognitoRegion) {
        setCognitoRegion(cached.cognitoRegion);
      }
      if (cached.invitationToken) {
        setInvitationInput(cached.invitationToken);
      }
      if (cached.captureUri) {
        const restored = await describeLocalCapture(cached.captureUri, {
          byteSize: cached.captureByteSize,
          durationMs: cached.captureDurationMs,
          contentType: cached.evidenceContentType,
        });
        if (restored) {
          setLocalCapture(restored);
          setCaptureStatus(cached.evidenceIdempotencyKey ? "retry" : "captured");
        } else {
          await persist({
            ...cached,
            captureUri: null,
            evidenceIdempotencyKey: null,
            evidenceContentType: null,
            captureByteSize: null,
            captureDurationMs: null,
          });
          setCaptureStatus("idle");
          setError("Local capture was removed by the device. Record packing evidence again.");
        }
      }
      try {
        const restored = await restoreAuthoritativeSession(cached);
        if (!restored) {
          return;
        }
        setScreen("home");
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          tokenRef.current = null;
          sessionRef.current = null;
          await clearCachedState();
          setSession(null);
          setAuthMode(defaultAuthMode());
          setAuthPane("signIn");
          setScreen("auth");
          setError("Session expired. Sign in again.");
          return;
        }
        setError(formatError(err));
        setScreen("home");
      }
    })();
  }, []);

  async function persist(next: CachedClientState): Promise<void> {
    tokenRef.current = next.token;
    sessionRef.current = next;
    setSession(next);
    await saveCachedState(next);
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

  async function restoreAuthoritativeSession(
    cached: CachedClientState,
  ): Promise<CachedClientState | null> {
    let next = cached;
    if (cached.authMode === "cognito" && cached.refreshToken) {
      const needsRefresh =
        !cached.accessExpiresAt || cached.accessExpiresAt - Date.now() < 60_000;
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
      proofId: null,
      transactionId: null,
      invitationToken: null,
      captureUri: null,
      evidenceIdempotencyKey: null,
      evidenceContentType: null,
      captureByteSize: null,
      captureDurationMs: null,
    };
    await persist(next);
    await applyProfile(profile);
    const inbox = await client.listInvitations();
    setPendingInvites(inbox.invitations);
    const collection = await client.listMyProofs();
    setProofCollection(collection.proofs);
    setProof(null);
    setTransactionDetail(null);
    setLocalCapture(null);
    setCaptureStatus("idle");
    setUploadPercent(null);
    setCreateForm(EMPTY_FORM);
    setEditForm(EMPTY_FORM);
    setManifest(null);
    setSearchResults([]);
    setSelectedBuyer(null);
    return profile;
  }

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

  async function refreshPendingInvites(): Promise<void> {
    const inbox = await client.listInvitations();
    setPendingInvites(inbox.invitations);
  }

  async function refreshProofCollection(): Promise<void> {
    const collection = await client.listMyProofs();
    setProofCollection(collection.proofs);
  }

  async function openDiscoveredProof(proofId: string): Promise<void> {
    const current = sessionRef.current;
    if (current) {
      await persist({ ...current, proofId });
    }
    await refreshProof(proofId);
    setScreen("proof");
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

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await ensureFreshCognitoToken();
      await action();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
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
    const current = sessionRef.current;
    if (current) {
      await persist({ ...current, proofId: fresh.proofId, transactionId: fresh.transactionId });
    }
    return fresh;
  }

  const role = proof?.participants.find((p) => p.userId === session?.userId)?.role;
  const finalized = proof?.status === "FINALIZED";
  const committedEvidence = (proof?.evidence ?? []).filter(
    (item) => item.validationStatus === "COMMITTED",
  );
  const pendingEvidence = (proof?.evidence ?? []).filter(
    (item) => item.validationStatus === "PENDING",
  );
  const activeProofs = proofCollection.filter((item) => item.status !== "FINALIZED");
  const completedProofs = proofCollection.filter((item) => item.status === "FINALIZED");
  const canCapture =
    !finalized &&
    role === "SELLER" &&
    proof?.status === "READY_FOR_EVIDENCE" &&
    committedEvidence.length === 0;

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>PackProof V2</Text>
        <Text style={styles.subtitle}>Thin client. Server owns Proof state.</Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {busy ? <Text style={styles.busy}>Working…</Text> : null}

        {screen === "auth" ? (
          <View style={styles.card}>
            <Text style={styles.label}>API base URL</Text>
            <TextInput
              style={styles.input}
              value={apiBaseUrl}
              onChangeText={setApiBaseUrl}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.label}>Auth mode: {authMode}</Text>
            <Action
              label="Use development sign-in"
              disabled={busy}
              onPress={() => setAuthMode("dev")}
            />
            <Action
              label="Use PackProof account"
              disabled={busy}
              onPress={() => setAuthMode("cognito")}
            />
            {authMode === "cognito" && showCognitoSettings ? (
              <View>
                <Text style={styles.label}>Cognito User Pool ID</Text>
                <TextInput
                  style={styles.input}
                  value={cognitoPoolId}
                  onChangeText={setCognitoPoolId}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.label}>Cognito app client ID</Text>
                <TextInput
                  style={styles.input}
                  value={cognitoClientId}
                  onChangeText={setCognitoClientId}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.label}>Cognito region</Text>
                <TextInput
                  style={styles.input}
                  value={cognitoRegion}
                  onChangeText={setCognitoRegion}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            ) : null}
            {authMode === "cognito" ? (
              <Action
                label={showCognitoSettings ? "Hide Cognito settings" : "Show Cognito settings"}
                disabled={busy}
                onPress={() => setShowCognitoSettings((value) => !value)}
              />
            ) : null}

            {authPane === "signIn" ? (
              <View>
                {authMode === "dev" ? (
                  <View>
                    <Text style={styles.label}>Dev subject</Text>
                    <TextInput
                      style={styles.input}
                      value={subject}
                      onChangeText={setSubject}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                ) : (
                  <View>
                    <Text style={styles.label}>Email</Text>
                    <TextInput
                      style={styles.input}
                      value={email}
                      onChangeText={setEmail}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="email-address"
                    />
                    <Text style={styles.label}>Password</Text>
                    <TextInput
                      style={styles.input}
                      value={password}
                      onChangeText={setPassword}
                      autoCapitalize="none"
                      autoCorrect={false}
                      secureTextEntry
                    />
                  </View>
                )}
                <Action
                  label="Sign in"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      if (authMode === "dev") {
                        const result = await client.login(subject.trim());
                        await finishSignIn({
                          token: result.token,
                          subject: subject.trim(),
                        });
                      } else {
                        const tokens = await cognitoSignIn(requireCognitoConfig(), {
                          email: email.trim(),
                          password,
                        });
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
                      setScreen("home");
                    })
                  }
                />
                {authMode === "cognito" ? (
                  <View>
                    <Action label="Create account" disabled={busy} onPress={() => setAuthPane("createAccount")} />
                    <Action label="Forgot password" disabled={busy} onPress={() => setAuthPane("forgot")} />
                    <Action
                      label="I have a verification code"
                      disabled={busy}
                      onPress={() => setAuthPane("verify")}
                    />
                  </View>
                ) : null}
              </View>
            ) : null}

            {authPane === "createAccount" ? (
              <View>
                <Text style={styles.heading}>Create account</Text>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
                <Text style={styles.label}>Password</Text>
                <TextInput
                  style={styles.input}
                  value={password}
                  onChangeText={setPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
                <Text style={styles.label}>Username</Text>
                <TextInput
                  style={styles.input}
                  value={usernameInput}
                  onChangeText={setUsernameInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.label}>Display name</Text>
                <TextInput
                  style={styles.input}
                  value={displayNameInput}
                  onChangeText={setDisplayNameInput}
                  autoCorrect={false}
                />
                <Action
                  label="Create account"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const created = await cognitoSignUp(requireCognitoConfig(), {
                        email: email.trim(),
                        password,
                      });
                      setPassword("");
                      if (created.userConfirmed) {
                        setAuthPane("signIn");
                      } else {
                        setAuthPane("verify");
                      }
                    })
                  }
                />
                <Action label="Back to sign in" disabled={busy} onPress={() => setAuthPane("signIn")} />
              </View>
            ) : null}

            {authPane === "verify" ? (
              <View>
                <Text style={styles.heading}>Verify email</Text>
                <Text>Enter the verification code sent to {email || "your email"}.</Text>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
                <Text style={styles.label}>Verification code</Text>
                <TextInput
                  style={styles.input}
                  value={verificationCode}
                  onChangeText={setVerificationCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="number-pad"
                />
                <Action
                  label="Verify email"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      await cognitoConfirmSignUp(requireCognitoConfig(), {
                        email: email.trim(),
                        code: verificationCode.trim(),
                      });
                      setVerificationCode("");
                      setAuthPane("signIn");
                    })
                  }
                />
                <Action
                  label="Resend verification code"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      await cognitoResendConfirmation(requireCognitoConfig(), email.trim());
                    })
                  }
                />
                <Action label="Back to sign in" disabled={busy} onPress={() => setAuthPane("signIn")} />
              </View>
            ) : null}

            {authPane === "forgot" ? (
              <View>
                <Text style={styles.heading}>Forgot password</Text>
                <Text style={styles.label}>Email</Text>
                <TextInput
                  style={styles.input}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
                <Action
                  label="Send reset code"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      await cognitoForgotPassword(requireCognitoConfig(), email.trim());
                      setAuthPane("reset");
                    })
                  }
                />
                <Action label="Back to sign in" disabled={busy} onPress={() => setAuthPane("signIn")} />
              </View>
            ) : null}

            {authPane === "reset" ? (
              <View>
                <Text style={styles.heading}>Reset password</Text>
                <Text>Enter the reset code sent to {email || "your email"}.</Text>
                <Text style={styles.label}>Reset code</Text>
                <TextInput
                  style={styles.input}
                  value={verificationCode}
                  onChangeText={setVerificationCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="number-pad"
                />
                <Text style={styles.label}>New password</Text>
                <TextInput
                  style={styles.input}
                  value={newPassword}
                  onChangeText={setNewPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                />
                <Action
                  label="Reset password"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      await cognitoConfirmForgotPassword(requireCognitoConfig(), {
                        email: email.trim(),
                        code: verificationCode.trim(),
                        password: newPassword,
                      });
                      setVerificationCode("");
                      setNewPassword("");
                      setAuthPane("signIn");
                    })
                  }
                />
                <Action label="Back to sign in" disabled={busy} onPress={() => setAuthPane("signIn")} />
              </View>
            ) : null}
          </View>
        ) : null}

        {screen === "home" && session ? (
          <View style={styles.card}>
            <Text style={styles.heading}>Account</Text>
            <Text>Signed in as {session.username ?? session.subject}</Text>
            <Text>{session.displayName ?? ""}</Text>
            <Text selectable>userId {session.userId}</Text>
            {!session.username ? (
              <View>
                <Text>Complete your PackProof username to appear in search.</Text>
                <Text style={styles.label}>Username</Text>
                <TextInput
                  style={styles.input}
                  value={usernameInput}
                  onChangeText={setUsernameInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.label}>Display name</Text>
                <TextInput
                  style={styles.input}
                  value={displayNameInput}
                  onChangeText={setDisplayNameInput}
                  autoCorrect={false}
                />
                <Action
                  label="Save profile"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const updated = await client.updateProfile({
                        username: usernameInput.trim(),
                        displayName: displayNameInput.trim() || usernameInput.trim(),
                      });
                      await applyProfile(updated);
                    })
                  }
                />
              </View>
            ) : (
              <View>
                <Text style={styles.label}>Display name</Text>
                <TextInput
                  style={styles.input}
                  value={displayNameInput}
                  onChangeText={setDisplayNameInput}
                  autoCorrect={false}
                />
                <Action
                  label="Update display name"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const updated = await client.updateProfile({
                        displayName: displayNameInput.trim(),
                      });
                      await applyProfile(updated);
                    })
                  }
                />
              </View>
            )}
            <Text style={styles.heading}>Active Proofs</Text>
            {activeProofs.length === 0 ? <Text>No active Proofs.</Text> : null}
            {activeProofs.map((item) => (
              <View key={item.proofId} style={styles.invite}>
                <Text>{item.transaction.itemTitle ?? "Untitled item"}</Text>
                <Text>{item.transaction.externalReference ?? ""}</Text>
                <Text>
                  {item.role} {item.status}
                </Text>
                <Text>
                  {[item.transaction.carrier, item.transaction.trackingNumber]
                    .filter(Boolean)
                    .join(" ")}
                </Text>
                <Text selectable>proofId {item.proofId}</Text>
                <Action
                  label="Open Proof"
                  disabled={busy}
                  onPress={() => run(async () => openDiscoveredProof(item.proofId))}
                />
              </View>
            ))}
            <Text style={styles.heading}>Completed Proofs</Text>
            {completedProofs.length === 0 ? <Text>No completed Proofs.</Text> : null}
            {completedProofs.map((item) => (
              <View key={item.proofId} style={styles.invite}>
                <Text>{item.transaction.itemTitle ?? "Untitled item"}</Text>
                <Text>{item.transaction.externalReference ?? ""}</Text>
                <Text>
                  {item.role} {item.status}
                </Text>
                <Text>{item.finalizedAt ?? ""}</Text>
                <Text selectable>proofId {item.proofId}</Text>
                <Action
                  label="Open finalized Proof"
                  disabled={busy}
                  onPress={() => run(async () => openDiscoveredProof(item.proofId))}
                />
              </View>
            ))}
            <Action
              label="Refresh Proofs"
              disabled={busy}
              onPress={() =>
                run(async () => {
                  await refreshProofCollection();
                  await refreshPendingInvites();
                })
              }
            />
            <Text style={styles.heading}>Pending invitations</Text>
            {pendingInvites.length === 0 ? <Text>No pending invitations.</Text> : null}
            {pendingInvites.map((invite) => (
              <View key={invite.invitationId} style={styles.invite}>
                <Text selectable>
                  {invite.inviter.displayName ?? invite.inviter.username ?? invite.inviter.userId}
                </Text>
                <Text>{invite.transaction.itemTitle ?? "Untitled item"}</Text>
                <Text>{invite.transaction.externalReference ?? ""}</Text>
                <Text selectable>proofId {invite.proofId}</Text>
                <Text>{invite.createdAt}</Text>
                <Action
                  label="Accept invitation"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const accepted = await client.acceptInvitation(invite.invitationId);
                      const next = {
                        ...session,
                        proofId: accepted.proof.proofId,
                        transactionId: accepted.proof.transactionId,
                      };
                      await persist(next);
                      await refreshPendingInvites();
                      await refreshProofCollection();
                      await refreshProof(accepted.proof.proofId);
                      setScreen("proof");
                    })
                  }
                />
              </View>
            ))}
            <Action
              label="Refresh invitations"
              disabled={busy}
              onPress={() => run(async () => refreshPendingInvites())}
            />
            <Text style={styles.heading}>New transaction</Text>
            <ContextFields form={createForm} onChange={setCreateForm} />
            <Action
              label="Create transaction and Proof"
              disabled={busy}
              onPress={() =>
                run(async () => {
                  const parsed = parseContextForm(createForm);
                  const txn = await client.createTransaction({
                    ...parsed.transaction,
                    shipping: parsed.shipping,
                  });
                  const created = await client.createOrGetProof(txn.transactionId);
                  const next = {
                    ...session,
                    proofId: created.proofId,
                    transactionId: created.transactionId,
                  };
                  await persist(next);
                  await refreshProofCollection();
                  await refreshProof(created.proofId);
                  setScreen("proof");
                })
              }
            />
            {session.proofId ? (
              <Action
                label="Open cached Proof from server"
                disabled={busy}
                onPress={() =>
                  run(async () => {
                    await refreshProof(session.proofId as string);
                    setScreen("proof");
                  })
                }
              />
            ) : null}
            <Text style={styles.label}>Invitation token</Text>
            <TextInput
              style={styles.input}
              value={invitationInput}
              onChangeText={setInvitationInput}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Action
              label="Accept invitation"
              disabled={busy}
              onPress={() =>
                run(async () => {
                  const accepted = await client.acceptInvitation(invitationInput.trim());
                  const next = {
                    ...session,
                    proofId: accepted.proof.proofId,
                    transactionId: accepted.proof.transactionId,
                    invitationToken: accepted.invitation.token,
                  };
                  await persist(next);
                  await refreshProof(accepted.proof.proofId);
                  setScreen("proof");
                })
              }
            />
            <Action
              label="Sign out"
              disabled={busy}
              onPress={() =>
                run(async () => {
                  if (session.authMode === "cognito" && session.token && session.cognitoClientId) {
                    await cognitoGlobalSignOut(
                      {
                        userPoolId: session.cognitoUserPoolId ?? cognitoPoolId,
                        clientId: session.cognitoClientId,
                        region: session.cognitoRegion ?? cognitoRegion,
                      },
                      session.token,
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
                  setEditForm(EMPTY_FORM);
                  setManifest(null);
                  setPendingInvites([]);
                  setProofCollection([]);
                  setSearchResults([]);
                  setSelectedBuyer(null);
                  setPassword("");
                  setAuthPane("signIn");
                  setScreen("auth");
                })
              }
            />
          </View>
        ) : null}

        {screen === "proof" && session && proof ? (
          <View style={styles.card}>
            <Text style={styles.heading}>Authoritative Proof</Text>
            <Text selectable>proofId {proof.proofId}</Text>
            <Text selectable>transactionId {proof.transactionId}</Text>
            <Text>status {proof.status}</Text>
            <Text>role {role ?? "none"}</Text>
            <Text style={styles.heading}>Transaction and shipping</Text>
            {transactionDetail ? (
              <TransactionFacts
                transaction={transactionDetail}
                proofId={proof.proofId}
                proofStatus={proof.status}
                sellerUserId={
                  proof.participants.find((p) => p.role === "SELLER")?.userId ??
                  transactionDetail.sellerUserId
                }
                buyerUserId={
                  proof.participants.find((p) => p.role === "BUYER")?.userId ??
                  transactionDetail.buyerUserId
                }
              />
            ) : (
              <Text>Loading transaction from server…</Text>
            )}
            {!finalized && role === "SELLER" ? (
              <View>
                <Text style={styles.heading}>Edit transaction</Text>
                <ContextFields form={editForm} onChange={setEditForm} />
                <Action
                  label="Save transaction details"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const parsed = parseContextForm(editForm);
                      const updated = await client.updateTransaction(proof.transactionId, {
                        ...parsed.transaction,
                      });
                      setTransactionDetail(updated);
                      setEditForm(formFromTransaction(updated));
                      await refreshProof(proof.proofId);
                    })
                  }
                />
                <Action
                  label="Save shipping details"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const parsed = parseContextForm(editForm);
                      const updated = await client.updateShipping(
                        proof.transactionId,
                        parsed.shipping,
                      );
                      setTransactionDetail(updated);
                      setEditForm(formFromTransaction(updated));
                      await refreshProof(proof.proofId);
                    })
                  }
                />
              </View>
            ) : null}
            <Text>participants</Text>
            {proof.participants.map((p) => (
              <Text key={p.participantId}>
                {p.role} {p.status} {p.userId}
              </Text>
            ))}
            <Text style={styles.heading}>Required seller evidence</Text>
            {committedEvidence.length === 0 ? (
              <Text>not committed — capture remains local until the server confirms commit</Text>
            ) : (
              <Text>committed</Text>
            )}
            {committedEvidence.map((item) => (
              <Text key={item.evidenceId} selectable>
                COMMITTED {item.sha256 ?? ""} {item.byteSize != null ? formatBytes(item.byteSize) : ""}
              </Text>
            ))}
            {pendingEvidence.length > 0 && committedEvidence.length === 0 ? (
              <Text>upload started but not committed</Text>
            ) : null}
            {session.invitationToken ? (
              <Text selectable>invitation {session.invitationToken}</Text>
            ) : null}
            <Text>
              local capture {captureStatus}
              {localCapture
                ? ` ${formatBytes(localCapture.byteSize)} ${formatDuration(localCapture.durationMs)}`
                : ""}
            </Text>
            {captureStatus === "uploading" && uploadPercent != null ? (
              <Text>upload {uploadPercent}% — not committed</Text>
            ) : null}
            {captureStatus === "uploaded" ? (
              <Text>uploaded — committing on the server. Not committed until the API confirms.</Text>
            ) : null}
            {manifest ? (
              <View>
                <Text style={styles.heading}>Final manifest</Text>
                <Text selectable>sha256 {manifest.sha256}</Text>
                <Text selectable>{manifest.canonicalJson}</Text>
              </View>
            ) : null}

            <Action
              label="Refresh from server"
              disabled={busy}
              onPress={() => run(async () => refreshProof(proof.proofId).then(() => undefined))}
            />
            <Action
              label="Leave screen"
              disabled={busy}
              onPress={() =>
                run(async () => {
                  await refreshProofCollection();
                  await refreshPendingInvites();
                  setScreen("home");
                })
              }
            />

            {!finalized && role === "SELLER" ? (
              <View>
                <Text style={styles.heading}>Invite PackProof user</Text>
                <Text style={styles.label}>Search username</Text>
                <TextInput
                  style={styles.input}
                  value={searchQuery}
                  onChangeText={setSearchQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Action
                  label="Search users"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const result = await client.searchUsers(searchQuery.trim());
                      setSearchResults(result.users);
                    })
                  }
                />
                {searchResults.map((user) => (
                  <Action
                    key={user.userId}
                    label={
                      selectedBuyer?.userId === user.userId
                        ? `Selected ${user.username}`
                        : `${user.username} — ${user.displayName ?? user.userId}`
                    }
                    disabled={busy}
                    onPress={() => setSelectedBuyer(user)}
                  />
                ))}
                <Action
                  label={
                    selectedBuyer
                      ? `Invite ${selectedBuyer.username}`
                      : "Invite selected buyer"
                  }
                  disabled={busy || !selectedBuyer}
                  onPress={() =>
                    run(async () => {
                      if (!selectedBuyer) {
                        return;
                      }
                      const invited = await client.createInvitation(proof.proofId, {
                        inviteeUserId: selectedBuyer.userId,
                      });
                      const next = { ...session, invitationToken: invited.invitation.token };
                      await persist(next);
                      await refreshProof(proof.proofId);
                    })
                  }
                />
                <Text style={styles.label}>Token invitation fallback</Text>
                <TextInput
                  style={styles.input}
                  value={inviteeIdentifier}
                  onChangeText={setInviteeIdentifier}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Action
                  label="Invite by identifier"
                  disabled={busy || !inviteeIdentifier.trim()}
                  onPress={() =>
                    run(async () => {
                      const invited = await client.createInvitation(
                        proof.proofId,
                        inviteeIdentifier.trim(),
                      );
                      const next = { ...session, invitationToken: invited.invitation.token };
                      await persist(next);
                      await refreshProof(proof.proofId);
                    })
                  }
                />
                {canCapture ? (
                  <Action
                    label="Capture packing evidence"
                    disabled={busy}
                    onPress={() => {
                      setError(null);
                      setScreen("capture");
                    }}
                  />
                ) : null}
                {proof.status === "EVIDENCE_COMMITTED" ? (
                  <Action
                    label="Finalize Proof"
                    disabled={busy}
                    onPress={() =>
                      run(async () => {
                        const result = await client.finalizeProof(proof.proofId);
                        setProof(result.proof);
                        setManifest(result.manifest);
                        await refreshProof(result.proof.proofId);
                      })
                    }
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}

        {screen === "capture" && session && proof ? (
          <View style={styles.card}>
            <Text style={styles.heading}>Packing evidence capture</Text>
            <Text>
              Keep the packing and sealing process visible in the frame for the entire recording.
              Stop when the package is sealed. This local video is not Proof state until the server
              commits it.
            </Text>
            <Fact label="item title" value={transactionDetail?.itemTitle ?? proof.transaction.itemTitle} />
            <Fact
              label="transaction reference"
              value={transactionDetail?.externalReference ?? proof.transaction.externalReference}
            />
            <Fact
              label="carrier"
              value={
                transactionDetail?.shipping?.carrier ?? proof.transaction.shipping?.carrier
              }
            />
            <Fact
              label="tracking number"
              value={
                transactionDetail?.shipping?.trackingNumber ??
                proof.transaction.shipping?.trackingNumber
              }
            />
            <Text selectable>proofId {proof.proofId}</Text>
            <Text>Proof status {proof.status}</Text>
            <Text>local capture {captureStatus}</Text>
            {localCapture ? (
              <View>
                <Text>local video ready</Text>
                <Text>{formatBytes(localCapture.byteSize)}</Text>
                <Text>{formatDuration(localCapture.durationMs)}</Text>
                <Text selectable>{localCapture.uri}</Text>
              </View>
            ) : (
              <Text>no local capture</Text>
            )}
            {captureStatus === "uploading" ? (
              <Text>upload {uploadPercent ?? 0}% — bytes transferring. Not committed.</Text>
            ) : null}
            {captureStatus === "uploaded" ? (
              <Text>uploaded — committing on the server. Not committed until the API confirms.</Text>
            ) : null}
            {captureStatus === "retry" ? (
              <Text>upload or commit failed. Local capture kept. Proof is unchanged.</Text>
            ) : null}

            <Action
              label={localCapture ? "Retake video" : "Record packing evidence"}
              disabled={busy || captureStatus === "uploading" || captureStatus === "uploaded"}
              onPress={() =>
                run(async () => {
                  setCaptureStatus("capturing");
                  const captured = await recordPackingEvidence();
                  if (!captured) {
                    setCaptureStatus(localCapture ? "captured" : "idle");
                    return;
                  }
                  if (localCapture && localCapture.uri !== captured.uri) {
                    await discardLocalCapture(localCapture.uri);
                  }
                  await persistCapture(captured, session.evidenceIdempotencyKey);
                  setCaptureStatus("captured");
                  const fresh = await client.getProof(proof.proofId);
                  setProof(fresh);
                })
              }
            />
            {localCapture && captureStatus !== "uploading" && captureStatus !== "uploaded" ? (
              <Action
                label="Discard local capture"
                disabled={busy}
                onPress={() =>
                  run(async () => {
                    await discardLocalCapture(localCapture.uri);
                    await persistCapture(null, session.evidenceIdempotencyKey);
                    setCaptureStatus("idle");
                    const fresh = await client.getProof(proof.proofId);
                    setProof(fresh);
                  })
                }
              />
            ) : null}
            {localCapture ? (
              <Action
                label={captureStatus === "retry" ? "Retry upload and commit" : "Submit capture"}
                disabled={busy || captureStatus === "uploading" || captureStatus === "uploaded"}
                onPress={() =>
                  run(async () => {
                    const available = await localCaptureExists(localCapture.uri);
                    if (!available) {
                      await persistCapture(null, null);
                      setCaptureStatus("idle");
                      throw new Error(
                        "Captured video is no longer available. Record packing evidence again.",
                      );
                    }
                    const key = session.evidenceIdempotencyKey ?? newIdempotencyKey();
                    await persistCapture(localCapture, key);
                    setCaptureStatus("uploading");
                    setUploadPercent(0);
                    try {
                      const initialized = await client.initializeEvidenceUpload(proof.proofId, {
                        contentType: localCapture.contentType,
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
                      setScreen("proof");
                    } catch (err) {
                      setCaptureStatus("retry");
                      throw err;
                    }
                  })
                }
              />
            ) : null}
            <Action
              label="Back to Proof"
              disabled={busy && captureStatus === "uploading"}
              onPress={() =>
                run(async () => {
                  await refreshProof(proof.proofId);
                  setScreen("proof");
                })
              }
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function Action(props: { label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={[styles.button, props.disabled ? styles.buttonDisabled : null]}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

function displayValue(value: string | number | null | undefined): string {
  if (value == null || value === "") {
    return "—";
  }
  return String(value);
}

function formFromTransaction(transaction: TransactionView): ContextForm {
  return {
    externalReference: transaction.externalReference ?? "",
    transactionDate: transaction.transactionDate ?? "",
    itemTitle: transaction.itemTitle ?? "",
    itemDescription: transaction.itemDescription ?? "",
    quantity: transaction.quantity == null ? "" : String(transaction.quantity),
    transactionValue:
      transaction.transactionValue == null ? "" : String(transaction.transactionValue),
    currency: transaction.currency ?? "",
    carrier: transaction.shipping?.carrier ?? "",
    service: transaction.shipping?.service ?? "",
    trackingNumber: transaction.shipping?.trackingNumber ?? "",
    shipmentDate: transaction.shipping?.shipmentDate ?? "",
  };
}

function parseOptionalInteger(raw: string, field: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return Number(trimmed);
}

function parseOptionalAmount(raw: string, field: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

function parseContextForm(form: ContextForm): {
  transaction: {
    externalReference: string | null;
    transactionDate: string | null;
    itemTitle: string | null;
    itemDescription: string | null;
    quantity: number | null;
    transactionValue: number | null;
    currency: string | null;
  };
  shipping: {
    carrier: string | null;
    service: string | null;
    trackingNumber: string | null;
    shipmentDate: string | null;
  };
} {
  return {
    transaction: {
      externalReference: form.externalReference.trim() || null,
      transactionDate: form.transactionDate.trim() || null,
      itemTitle: form.itemTitle.trim() || null,
      itemDescription: form.itemDescription.trim() || null,
      quantity: parseOptionalInteger(form.quantity, "quantity"),
      transactionValue: parseOptionalAmount(form.transactionValue, "transaction value"),
      currency: form.currency.trim() || null,
    },
    shipping: {
      carrier: form.carrier.trim() || null,
      service: form.service.trim() || null,
      trackingNumber: form.trackingNumber.trim() || null,
      shipmentDate: form.shipmentDate.trim() || null,
    },
  };
}

function ContextFields(props: {
  form: ContextForm;
  onChange: (form: ContextForm) => void;
}) {
  const set = (key: keyof ContextForm, value: string) => {
    props.onChange({ ...props.form, [key]: value });
  };
  return (
    <View>
      <LabeledInput
        label="Transaction reference / order number"
        value={props.form.externalReference}
        onChangeText={(value) => set("externalReference", value)}
      />
      <LabeledInput
        label="Transaction date (YYYY-MM-DD)"
        value={props.form.transactionDate}
        onChangeText={(value) => set("transactionDate", value)}
      />
      <LabeledInput
        label="Item title"
        value={props.form.itemTitle}
        onChangeText={(value) => set("itemTitle", value)}
      />
      <LabeledInput
        label="Item description"
        value={props.form.itemDescription}
        onChangeText={(value) => set("itemDescription", value)}
        multiline
      />
      <LabeledInput
        label="Quantity"
        value={props.form.quantity}
        onChangeText={(value) => set("quantity", value)}
        keyboardType="number-pad"
      />
      <LabeledInput
        label="Transaction value"
        value={props.form.transactionValue}
        onChangeText={(value) => set("transactionValue", value)}
        keyboardType="decimal-pad"
      />
      <LabeledInput
        label="Currency"
        value={props.form.currency}
        onChangeText={(value) => set("currency", value)}
        autoCapitalize="characters"
      />
      <LabeledInput
        label="Carrier"
        value={props.form.carrier}
        onChangeText={(value) => set("carrier", value)}
      />
      <LabeledInput
        label="Shipping service"
        value={props.form.service}
        onChangeText={(value) => set("service", value)}
      />
      <LabeledInput
        label="Tracking number"
        value={props.form.trackingNumber}
        onChangeText={(value) => set("trackingNumber", value)}
      />
      <LabeledInput
        label="Shipment date (YYYY-MM-DD)"
        value={props.form.shipmentDate}
        onChangeText={(value) => set("shipmentDate", value)}
      />
    </View>
  );
}

function TransactionFacts(props: {
  transaction: TransactionView;
  proofId: string;
  proofStatus: string;
  sellerUserId: string | null | undefined;
  buyerUserId: string | null | undefined;
}) {
  const shipping = props.transaction.shipping;
  return (
    <View>
      <Fact label="item title" value={props.transaction.itemTitle} />
      <Fact label="item description" value={props.transaction.itemDescription} />
      <Fact label="quantity" value={props.transaction.quantity} />
      <Fact
        label="transaction value"
        value={
          props.transaction.transactionValue == null
            ? null
            : `${props.transaction.transactionValue} ${props.transaction.currency ?? ""}`.trim()
        }
      />
      <Fact label="transaction reference" value={props.transaction.externalReference} />
      <Fact label="transaction date" value={props.transaction.transactionDate} />
      <Fact label="seller" value={props.sellerUserId} />
      <Fact label="buyer" value={props.buyerUserId} />
      <Fact label="carrier" value={shipping?.carrier} />
      <Fact label="shipping service" value={shipping?.service} />
      <Fact label="tracking number" value={shipping?.trackingNumber} />
      <Fact label="shipment date" value={shipping?.shipmentDate} />
      <Fact label="associated Proof ID" value={props.proofId} />
      <Fact label="current Proof status" value={props.proofStatus} />
    </View>
  );
}

function Fact(props: { label: string; value: string | number | null | undefined }) {
  return (
    <Text selectable>
      {props.label} {displayValue(props.value)}
    </Text>
  );
}

function LabeledInput(props: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  multiline?: boolean;
  keyboardType?: "default" | "number-pad" | "decimal-pad";
  autoCapitalize?: "none" | "characters";
}) {
  return (
    <View>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        style={[styles.input, props.multiline ? styles.multiline : null]}
        value={props.value}
        onChangeText={props.onChangeText}
        autoCapitalize={props.autoCapitalize ?? "none"}
        autoCorrect={false}
        multiline={props.multiline}
        keyboardType={props.keyboardType ?? "default"}
      />
    </View>
  );
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof CognitoAuthError) {
    return formatCognitoError(error);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingTop: 48, gap: 12 },
  title: { fontSize: 22, fontWeight: "700" },
  subtitle: { color: "#444" },
  card: { gap: 10, borderWidth: 1, borderColor: "#ccc", padding: 12 },
  invite: { gap: 6, borderWidth: 1, borderColor: "#ddd", padding: 8 },
  heading: { fontWeight: "700", marginTop: 8 },
  label: { marginTop: 6, fontWeight: "600" },
  input: { borderWidth: 1, borderColor: "#999", padding: 8 },
  multiline: { minHeight: 72, textAlignVertical: "top" },
  button: { backgroundColor: "#111", padding: 12 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: "#fff", textAlign: "center" },
  error: { color: "#a40000" },
  busy: { color: "#333" },
});
