import { recordNativeStudyInteraction } from "../analytics/native-study";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Share, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { isShareTransportFailure, loadSharedLink, removeSharedLink, reusableSharedLink, saveSharedLink } from "../copy/share-cache";
import { useTheme } from "../theme/ThemeProvider";
import { radii, sizes, spacing, typography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { Button } from "../ui/Button";
import { FadeSlideIn, PressableScale } from "../ui/motion";
import type { AccessLinkView } from "../v2-api";

type ShareScope = {
  proofId: string;
  tracker: { itemTitle: string | null };
  evidence: Array<{ evidenceId: string }>;
  disclosure: { viewHash: string; sharingNotice?: string };
};

const SHARED_PROOF = { purpose: "SHARED_PROOF" } as const;
const PENDING_NOTICE = "This is your saved link. Pending changes will appear after sync. Link access cannot be checked while you are offline.";

export function SharingScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const proofId = app.proof?.proofId;
  const userId = app.session?.userId;
  const apiBaseUrl = app.client.apiBaseUrl;
  const scopeKey = `${apiBaseUrl}|${userId ?? ""}|${proofId ?? ""}`;
  const scopeRef = useRef(scopeKey);
  scopeRef.current = scopeKey;
  const mounted = useRef(true);
  const [scope, setScope] = useState<ShareScope | null>(null);
  const [readyScopeKey, setReadyScopeKey] = useState("");
  const [reviewRequired, setReviewRequired] = useState(false);
  const [link, setLink] = useState<AccessLinkView | null>(null);
  const currentLink = useRef<AccessLinkView | null>(null);
  const [links, setLinks] = useState<AccessLinkView[]>([]);
  const [showLinks, setShowLinks] = useState(false);
  const [busy, setBusy] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [offlineMode, setOfflineMode] = useState(app.offline);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const lock = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { setOfflineMode(app.offline); }, [app.offline]);

  function isCurrent() { return mounted.current && scopeRef.current === scopeKey; }
  function assertCurrent() {
    if (!isCurrent()) throw new Error("Reopen sharing from your current account.");
  }
  function rememberLink(next: AccessLinkView | null) {
    assertCurrent();
    currentLink.current = next;
    setLink(next);
  }
  async function forgetLink() {
    if (!proofId || !userId) return;
    rememberLink(null);
    await removeSharedLink(AsyncStorage, apiBaseUrl, userId, proofId);
  }
  async function persistLink(next: AccessLinkView) {
    assertCurrent();
    rememberLink(next);
    try {
      await saveSharedLink(AsyncStorage, apiBaseUrl, userId!, proofId!, next);
    } catch {
      // The server link remains valid if local persistence fails; disclose that
      // it cannot be promised as an offline fallback after this screen closes.
      if (isCurrent()) setNotice("This link is available now, but could not be saved on this device for offline use.");
    }
    if (!isCurrent()) {
      await removeSharedLink(AsyncStorage, apiBaseUrl, userId!, proofId!);
      assertCurrent();
    }
  }
  const request = <T,>(path: string, method = "GET", body?: unknown) =>
    app.client.disclosureRequest<T>(proofId!, path, method, body);

  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      assertCurrent();
      await fn();
    } catch (e) {
      if (!isCurrent()) return;
      if (isShareTransportFailure(e)) {
        setOfflineMode(true);
        setError(reusableSharedLink(currentLink.current, proofId ?? "")
          ? "Unable to connect. You can still copy your saved link."
          : "Connect to create a share link. Your Proof remains saved.");
      } else {
        const status = (e as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404 || status === 410) {
          await forgetLink().catch(() => undefined);
          setScope(null);
        }
        setError(e instanceof Error ? e.message : "Sharing is unavailable. Please try again.");
      }
    } finally {
      lock.current = false;
      if (isCurrent()) setBusy(false);
    }
  }

  async function loadScope() {
    await app.ensureAuth();
    assertCurrent();
    const next = await request<ShareScope>("/preview", "POST", SHARED_PROOF);
    assertCurrent();
    if (next.proofId !== proofId) throw new Error("Please reopen this Proof to share it.");
    setScope(next);
    setOfflineMode(false);
  }

  useEffect(() => {
    let cancelled = false;
    setScope(null);
    setReadyScopeKey("");
    setReviewRequired(false);
    rememberLink(null);
    setLinks([]);
    setShowLinks(false);
    setError(null);
    setNotice(null);
    setInitializing(true);
    void (async () => {
      if (!proofId || !userId) return;
      const saved = await loadSharedLink(AsyncStorage, apiBaseUrl, userId, proofId).catch(() => null);
      if (cancelled || !isCurrent()) return;
      rememberLink(saved);
      setReadyScopeKey(scopeKey);
      if (!app.offline) await run(loadScope);
    })().finally(() => { if (!cancelled && isCurrent()) setInitializing(false); });
    return () => { cancelled = true; };
  }, [scopeKey]);

  async function reloadLinks() {
    await app.ensureAuth();
    assertCurrent();
    const latest = (await app.client.listAccessLinks(proofId!)).accessLinks;
    assertCurrent();
    setLinks(latest);
    const saved = currentLink.current;
    if (saved) {
      const existing = latest.find(item => item.accessLinkId === saved.accessLinkId);
      if (!existing || !reusableSharedLink({ ...existing, token: saved.token, url: saved.url }, proofId!)) await forgetLink();
    }
    setOfflineMode(false);
  }

  async function getShareLink(): Promise<{ link: AccessLinkView & { url: string }; cached: boolean }> {
    assertCurrent();
    if (readyScopeKey !== scopeKey) throw new Error("Wait for sharing details to load for your current account.");
    let saved = currentLink.current;
    if (saved && !reusableSharedLink(saved, proofId!)) { await forgetLink(); saved = null; }
    if (offlineMode) {
      if (reusableSharedLink(saved, proofId!)) return { link: saved, cached: true };
      throw new Error("Connect to create a share link. Your Proof remains saved.");
    }
    try {
      await app.ensureAuth();
      assertCurrent();
      if (reusableSharedLink(saved, proofId!)) {
        // This checks participant access, expiry, revocation, and the approved
        // sharing policy without creating another grant or widening its scope.
        const verified = await request<AccessLinkView>("/reuse", "POST", { token: saved.token });
        assertCurrent();
        if (!reusableSharedLink(verified, proofId!)) throw new Error("This link is unavailable. Open Manage links to review access.");
        await persistLink(verified);
        return { link: verified, cached: false };
      }
      if (!scope || scope.proofId !== proofId) {
        await loadScope();
        throw new Error("Sharing details are ready. Review them, then choose Share Proof or Copy link.");
      }
      if (reviewRequired) throw new Error("Return to the Proof to review its updates before sharing.");
      let created: AccessLinkView;
      try {
        created = await request<AccessLinkView>("/grants", "POST", {
          ...SHARED_PROOF,
          originalsReviewed: true,
          previewHash: scope.disclosure.viewHash,
          expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
        });
      } catch (e) {
        if ((e as { code?: string }).code === "DISCLOSURE_PREVIEW_CHANGED") {
          await loadScope();
          setReviewRequired(true);
          throw new Error("This Proof changed. Return to the Proof to review its updates, then share again.");
        }
        throw e;
      }
      assertCurrent();
      if (!reusableSharedLink(created, proofId!)) throw new Error("The link is unavailable. Please reopen sharing and try again.");
      await persistLink(created);
      setLinks(previous => [created, ...previous.filter(item => item.accessLinkId !== created.accessLinkId)]);
      void recordNativeStudyInteraction(app.client, userId!, "share_created").catch(() => undefined);
      return { link: created, cached: false };
    } catch (e) {
      // A rejected/revoked grant cannot fall back to its cached bearer URL.
      if (isShareTransportFailure(e) && reusableSharedLink(saved, proofId!)) {
        assertCurrent();
        setOfflineMode(true);
        return { link: saved, cached: true };
      }
      throw e;
    }
  }

  async function handoff(mode: "share" | "copy") {
    const result = await getShareLink();
    assertCurrent();
    if (mode === "copy") {
      const copied = await Clipboard.setStringAsync(result.link.url);
      assertCurrent();
      if (!copied) throw new Error("The link could not be copied. Touch and hold the link below to copy it.");
      setNotice(result.cached ? `Link copied. ${PENDING_NOTICE}` : "Link copied.");
      return;
    }
    if (result.cached) setNotice(PENDING_NOTICE);
    const outcome = await Share.share({ message: `View this PackProof: ${result.link.url}`, url: result.link.url });
    assertCurrent();
    // Android may return sharedAction even on dismissal. Never interpret the
    // native result as delivery, or show a 'shared successfully' message.
    if (outcome.action === Share.dismissedAction && !result.cached) setNotice(null);
  }

  if (!proofId || !userId) {
    return (
      <AppScreen>
        <AppHeader title="Share Proof" onBack={app.goBack} />
        <Text style={[styles.body, { color: colors.textSecondary }]}>Connect to create a share link.</Text>
        <Button label="Share Proof" icon="share-outline" disabled onPress={() => undefined} />
      </AppScreen>
    );
  }

  const availableLink = readyScopeKey === scopeKey && reusableSharedLink(link, proofId) ? link : null;
  const savedEvidenceIds = new Set([...(scope?.evidence ?? []), ...(app.proof?.evidence.filter(item => item.validationStatus === "COMMITTED") ?? [])].map(item => item.evidenceId));
  const pendingLocal = app.savedRecordings.some(item => item.captureProofId === proofId &&
    (!item.uploadEvidenceId || !savedEvidenceIds.has(item.uploadEvidenceId)) &&
    !["CONFIRMATION_NEEDED", "FINALIZATION_PENDING", "FINALIZED"].includes(item.recovery?.phase ?? "LOCAL_ONLY")) ||
    (app.session?.captureProofId === proofId && Boolean(app.session.captureUri) &&
      (!app.session.uploadEvidenceId || !savedEvidenceIds.has(app.session.uploadEvidenceId)) &&
      !["idle", "committed"].includes(app.captureStatus));
  const activeLinks = links.filter(item => !item.revokedAt && (!item.expiresAt || (Number.isFinite(Date.parse(item.expiresAt)) && Date.parse(item.expiresAt) > Date.now())));
  const canHandoff = readyScopeKey === scopeKey && !initializing && !busy && !reviewRequired && Boolean(availableLink || scope);

  return (
    <AppScreen>
      <AppHeader title="Share Proof" onBack={app.goBack} />
      <View style={[styles.section, { borderBottomColor: colors.divider }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{app.proof?.transaction.itemTitle || "Shipment Proof"}</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>A viewing link to this same Proof, including future updates.</Text>
      </View>
      {error ? <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{error}</Text> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={[styles.body, { color: colors.textSecondary }]}>{notice}</Text> : null}
      {initializing ? <ActivityIndicator color={colors.primary} accessibilityLabel="Loading sharing details" /> : null}
      <View style={[styles.section, { borderBottomColor: colors.divider }]}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>What the link includes</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>Shipment details, saved original recordings, tracking, and confirmations. Anyone with the link can view the shared record until it expires or you revoke it.</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>Review recordings in the Proof for private information before sharing. New recordings and updates added later will appear through this same link.</Text>
        {pendingLocal ? <Text style={[styles.body, { color: colors.textSecondary }]}>A recording is still waiting to finish saving. Only recordings already saved to the Proof are available to the recipient.</Text> : scope?.evidence.length === 0 ? <Text style={[styles.body, { color: colors.textSecondary }]}>Recording has not been added yet. The recipient will see that this Proof is incomplete.</Text> : null}
        <Button label="Review Proof" variant="tertiary" onPress={app.goBack} />
      </View>
      {availableLink ? (
        <View style={styles.expiry}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>Current link</Text>
          <Text style={[styles.body, { color: colors.textSecondary }]}>{availableLink.expiresAt ? `Expires ${new Date(availableLink.expiresAt).toLocaleString()}` : "No expiry"}</Text>
          <Text selectable accessibilityLabel={`Share link: ${availableLink.url}`} style={[styles.url, { color: colors.primary }]}>{availableLink.url}</Text>
        </View>
      ) : (
        <View style={styles.expiry}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>New link expires in</Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Link expires in" style={styles.options}>
            {[1, 7, 30].map(value => (
              <PressableScale key={value} disabled={busy} accessibilityRole="radio" accessibilityLabel={`${value} ${value === 1 ? "day" : "days"}`} accessibilityState={{ selected: days === value, checked: days === value, disabled: busy }} onPress={() => setDays(value)} style={[styles.option, { backgroundColor: days === value ? colors.surface : "transparent", borderColor: days === value ? colors.primary : colors.border }]}>
                <Text style={[styles.optionText, { color: days === value ? colors.textPrimary : colors.textSecondary }]}>{value} {value === 1 ? "day" : "days"}</Text>
              </PressableScale>
            ))}
          </View>
        </View>
      )}
      {offlineMode ? <Text style={[styles.body, { color: colors.textSecondary }]}>{availableLink ? PENDING_NOTICE : "Connect to create a share link. Your Proof remains saved."}</Text> : null}
      {!availableLink && scope ? <Text style={[styles.body, { color: colors.textSecondary }]}>Share Proof or Copy link approves access to the contents described above. Sharing does not complete or confirm the Proof.</Text> : null}
      <Button label="Share Proof" icon="share-outline" disabled={!canHandoff || offlineMode && !availableLink} loading={busy} accessibilityHint={availableLink ? "Open your device's share options for this Proof" : "Approve the described access and open your device's share options"} onPress={() => void run(() => handoff("share"))} />
      <Button label="Copy link" icon="copy-outline" variant="secondary" disabled={!canHandoff || offlineMode && !availableLink} onPress={() => void run(() => handoff("copy"))} />
      {(!scope || offlineMode) && !initializing ? <Button label="Retry connection" variant="tertiary" disabled={busy} onPress={() => void run(loadScope)} /> : null}
      <PressableScale accessibilityRole="button" accessibilityLabel="Manage links" accessibilityState={{ expanded: showLinks, disabled: busy }} disabled={busy} onPress={() => {
        if (showLinks) setShowLinks(false);
        else void run(async () => { await reloadLinks(); setShowLinks(true); });
      }} style={styles.manage}>
        <Text style={[styles.optionText, { color: colors.textSecondary }]}>Manage links</Text>
        <Ionicons name={showLinks ? "chevron-up" : "chevron-down"} size={16} color={colors.textSecondary} />
      </PressableScale>
      {showLinks ? (
        <FadeSlideIn>
          <View style={styles.expiry}>
            <Text style={[styles.body, { color: colors.textSecondary }]}>{activeLinks.length === 0 ? "No active links." : "Revoking stops future access. It cannot remove copies someone has already saved."}</Text>
            {activeLinks.map(item => (
              <View key={item.accessLinkId} style={[styles.link, { borderTopColor: colors.divider }]}>
                <Text style={[styles.body, { color: colors.textPrimary }]}>Created {new Date(item.createdAt).toLocaleDateString()}</Text>
                <Text style={[styles.body, { color: colors.textSecondary }]}>{item.expiresAt ? `Expires ${new Date(item.expiresAt).toLocaleString()}` : "No expiry"}</Text>
                <Button label="Revoke link" variant="tertiary" disabled={busy} onPress={() => void run(async () => {
                  await app.ensureAuth();
                  assertCurrent();
                  await app.client.revokeAccessLink(proofId, item.accessLinkId);
                  assertCurrent();
                  if (currentLink.current?.accessLinkId === item.accessLinkId) await forgetLink();
                  await reloadLinks();
                  setNotice("Link revoked.");
                })} />
              </View>
            ))}
          </View>
        </FadeSlideIn>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.sectionTitle },
  heading: { ...typography.bodyStrong },
  body: { ...typography.body },
  section: { gap: spacing.md, paddingBottom: spacing.lg, borderBottomWidth: 1 },
  expiry: { gap: spacing.sm },
  options: { flexDirection: "row", gap: spacing.sm },
  option: { flex: 1, minHeight: sizes.touch, justifyContent: "center", alignItems: "center", borderRadius: radii.sm, borderWidth: 1, paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  optionText: { ...typography.bodyStrong },
  url: { ...typography.body, flexShrink: 1 },
  manage: { flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center", minHeight: sizes.touch },
  link: { gap: spacing.sm, paddingTop: spacing.md, borderTopWidth: 1 },
});
