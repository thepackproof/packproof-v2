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
import * as FileSystem from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import {
  ApiError,
  PackProofV2Client,
  newIdempotencyKey,
  type ManifestView,
  type ProofView,
  type TransactionView,
} from "./src/v2-api";
import {
  clearCachedState,
  loadCachedState,
  saveCachedState,
  type CachedClientState,
} from "./src/session";

type Screen = "auth" | "home" | "proof";
type LocalCaptureStatus = "idle" | "capturing" | "captured" | "uploading" | "retry";

const DEFAULT_API =
  Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://127.0.0.1:3000";

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
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API);
  const [subject, setSubject] = useState("seller-1");
  const [inviteeIdentifier, setInviteeIdentifier] = useState("buyer@example.com");
  const [invitationInput, setInvitationInput] = useState("");
  const [session, setSession] = useState<CachedClientState | null>(null);
  const [proof, setProof] = useState<ProofView | null>(null);
  const [transactionDetail, setTransactionDetail] = useState<TransactionView | null>(null);
  const [createForm, setCreateForm] = useState<ContextForm>(EMPTY_FORM);
  const [editForm, setEditForm] = useState<ContextForm>(EMPTY_FORM);
  const [manifest, setManifest] = useState<ManifestView | null>(null);
  const [captureStatus, setCaptureStatus] = useState<LocalCaptureStatus>("idle");
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
      setSubject(cached.subject);
      if (cached.invitationToken) {
        setInvitationInput(cached.invitationToken);
      }
      if (cached.captureUri) {
        setCaptureStatus("retry");
      }
      if (cached.proofId) {
        try {
          const fresh = await new PackProofV2Client({
            baseUrl: cached.apiBaseUrl,
            getToken: () => cached.token,
          }).getProof(cached.proofId);
          setProof(fresh);
          const txn = await new PackProofV2Client({
            baseUrl: cached.apiBaseUrl,
            getToken: () => cached.token,
          }).getTransaction(fresh.transactionId);
          setTransactionDetail(txn);
          setEditForm(formFromTransaction(txn));
          setScreen("proof");
          if (fresh.status === "FINALIZED") {
            const loaded = await new PackProofV2Client({
              baseUrl: cached.apiBaseUrl,
              getToken: () => cached.token,
            }).getManifest(fresh.proofId);
            setManifest(loaded);
          }
        } catch (err) {
          setError(formatError(err));
          setScreen("home");
        }
      } else {
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

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
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
            <Text style={styles.label}>Dev subject</Text>
            <TextInput
              style={styles.input}
              value={subject}
              onChangeText={setSubject}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Action
              label="Sign in"
              disabled={busy}
              onPress={() =>
                run(async () => {
                  const result = await client.login(subject.trim());
                  tokenRef.current = result.token;
                  const next: CachedClientState = {
                    apiBaseUrl: apiBaseUrl.trim(),
                    subject: subject.trim(),
                    userId: result.userId,
                    token: result.token,
                    proofId: null,
                    transactionId: null,
                    invitationToken: null,
                    captureUri: null,
                    evidenceIdempotencyKey: null,
                    evidenceContentType: null,
                  };
                  await persist(next);
                  setProof(null);
                  setTransactionDetail(null);
                  setCreateForm(EMPTY_FORM);
                  setEditForm(EMPTY_FORM);
                  setManifest(null);
                  setScreen("home");
                })
              }
            />
          </View>
        ) : null}

        {screen === "home" && session ? (
          <View style={styles.card}>
            <Text>Signed in as {session.subject}</Text>
            <Text selectable>userId {session.userId}</Text>
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
                  tokenRef.current = null;
                  sessionRef.current = null;
                  await clearCachedState();
                  setSession(null);
                  setProof(null);
                  setTransactionDetail(null);
                  setCreateForm(EMPTY_FORM);
                  setEditForm(EMPTY_FORM);
                  setManifest(null);
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
            <Text>evidence</Text>
            {proof.evidence.length === 0 ? <Text>none committed/pending</Text> : null}
            {proof.evidence.map((item) => (
              <Text key={item.evidenceId} selectable>
                {item.validationStatus} {item.sha256 ?? ""}
              </Text>
            ))}
            {session.invitationToken ? (
              <Text selectable>invitation {session.invitationToken}</Text>
            ) : null}
            <Text>local capture {captureStatus}</Text>
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
              onPress={() => setScreen("home")}
            />

            {!finalized && role === "SELLER" ? (
              <View>
                <Text style={styles.label}>Invitee identifier</Text>
                <TextInput
                  style={styles.input}
                  value={inviteeIdentifier}
                  onChangeText={setInviteeIdentifier}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Action
                  label="Invite buyer"
                  disabled={busy}
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
                <Action
                  label="Capture evidence"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      setCaptureStatus("capturing");
                      const captured = await captureEvidence();
                      if (!captured) {
                        setCaptureStatus(session.captureUri ? "retry" : "idle");
                        return;
                      }
                      const key = session.evidenceIdempotencyKey ?? newIdempotencyKey();
                      const next = {
                        ...session,
                        captureUri: captured.uri,
                        evidenceIdempotencyKey: key,
                        evidenceContentType: captured.contentType,
                      };
                      await persist(next);
                      setCaptureStatus("uploading");
                      try {
                        const bytes = await readUriBytes(captured.uri);
                        await client.submitEvidence({
                          proofId: proof.proofId,
                          bytes,
                          contentType: captured.contentType,
                          idempotencyKey: key,
                        });
                        await persist({
                          ...next,
                          captureUri: null,
                          evidenceIdempotencyKey: null,
                          evidenceContentType: null,
                        });
                        setCaptureStatus("idle");
                        await refreshProof(proof.proofId);
                      } catch (err) {
                        setCaptureStatus("retry");
                        throw err;
                      }
                    })
                  }
                />
                {captureStatus === "retry" && session.captureUri && session.evidenceIdempotencyKey ? (
                  <Action
                    label="Retry upload/commit"
                    disabled={busy}
                    onPress={() =>
                      run(async () => {
                        setCaptureStatus("uploading");
                        try {
                          const bytes = await readUriBytes(session.captureUri as string);
                          await client.submitEvidence({
                            proofId: proof.proofId,
                            bytes,
                            contentType: session.evidenceContentType ?? "image/jpeg",
                            idempotencyKey: session.evidenceIdempotencyKey as string,
                          });
                          await persist({
                            ...session,
                            captureUri: null,
                            evidenceIdempotencyKey: null,
                            evidenceContentType: null,
                          });
                          setCaptureStatus("idle");
                          await refreshProof(proof.proofId);
                        } catch (err) {
                          setCaptureStatus("retry");
                          throw err;
                        }
                      })
                    }
                  />
                ) : null}
                <Action
                  label="Finalize Proof"
                  disabled={busy}
                  onPress={() =>
                    run(async () => {
                      const result = await client.finalizeProof(proof.proofId);
                      setProof(result.proof);
                      setManifest(result.manifest);
                    })
                  }
                />
              </View>
            ) : null}
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
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function captureEvidence(): Promise<{ uri: string; contentType: string } | null> {
  const camera = await ImagePicker.requestCameraPermissionsAsync();
  if (camera.granted) {
    const photo = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.5,
    });
    if (!photo.canceled && photo.assets[0]?.uri) {
      return { uri: photo.assets[0].uri, contentType: photo.assets[0].mimeType ?? "image/jpeg" };
    }
  }
  const library = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!library.granted) {
    throw new Error("Camera and media library permission denied");
  }
  const picked = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    quality: 0.5,
  });
  if (picked.canceled || !picked.assets[0]?.uri) {
    return null;
  }
  return { uri: picked.assets[0].uri, contentType: picked.assets[0].mimeType ?? "image/jpeg" };
}

async function readUriBytes(uri: string): Promise<Uint8Array> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: "base64",
  });
  const binary = globalThis.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 16, paddingTop: 48, gap: 12 },
  title: { fontSize: 22, fontWeight: "700" },
  subtitle: { color: "#444" },
  card: { gap: 10, borderWidth: 1, borderColor: "#ccc", padding: 12 },
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
