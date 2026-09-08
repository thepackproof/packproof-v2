import { recordNativeStudyInteraction } from "../analytics/native-study";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Share, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePackProof } from "../app/PackProofProvider";
import { proofStatusLabel } from "../copy/status";
import { useTheme } from "../theme/ThemeProvider";
import { radii, sizes, spacing, typography } from "../theme/tokens";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { Button } from "../ui/Button";
import { InfoCard } from "../ui/ProofCard";
import { RecordedVideo } from "../ui/RecordedVideo";
import { StatusBadge } from "../ui/StatusBadge";
import { FadeSlideIn, PressableScale } from "../ui/motion";
import type { AccessLinkView } from "../v2-api";

type Preview = {
  proofId: string;
  status: string;
  tracker: {
    itemTitle: string | null;
    headline: string;
    milestones: Array<{ code: string; label: string; occurredAt: string | null; state?: string }>;
  };
  evidence: Array<{
    evidenceId: string;
    stageId?: string | null;
    label: string;
    contentType: string;
  }>;
  disclosure: { viewHash: string; liveProof?: boolean; sharingNotice?: string };
};

const SHARED_PROOF = { purpose: "SHARED_PROOF" } as const;

export function SharingScreen() {
  const app = usePackProof();
  const { colors } = useTheme();
  const proofId = app.proof?.proofId;
  const [preview, setPreview] = useState<Preview | null>(null);
  const [link, setLink] = useState<AccessLinkView | null>(null);
  const [links, setLinks] = useState<AccessLinkView[]>([]);
  const [showLinks, setShowLinks] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [openRecording, setOpenRecording] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(7);
  const lock = useRef(false);

  const request = <T,>(path: string, method = "GET", body?: unknown) =>
    app.client.disclosureRequest<T>(proofId!, path, method, body);

  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await app.ensureAuth();
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sharing is unavailable. Please try again.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function loadPreview() {
    const next = await request<Preview>("/preview", "POST", SHARED_PROOF);
    if (next.proofId !== proofId) throw new Error("Please reopen this Proof to share it.");
    setPreview(next);
    setOpenRecording(next.evidence[0]?.evidenceId ?? null);
  }

  async function reloadLinks() {
    setLinks((await app.client.listAccessLinks(proofId!)).accessLinks);
  }

  useEffect(() => {
    if (proofId) void run(loadPreview);
  }, [proofId]);

  async function shareProof() {
    if (!preview || preview.proofId !== proofId) return;
    let currentLink = link;
    if (currentLink) {
      // A link may have been revoked on another device since the last share.
      const latest = (await app.client.listAccessLinks(proofId!)).accessLinks;
      setLinks(latest);
      const storedLink = latest.find((item) => item.accessLinkId === currentLink!.accessLinkId);
      currentLink = storedLink && !storedLink.revokedAt
        ? { ...storedLink, url: currentLink.url }
        : null;
      if (!currentLink) setLink(null);
    }
    if (!currentLink || currentLink.revokedAt || (currentLink.expiresAt && Date.parse(currentLink.expiresAt) <= Date.now())) {
      try {
        currentLink = await request<AccessLinkView>("/grants", "POST", {
          ...SHARED_PROOF,
          originalsReviewed: true,
          previewHash: preview.disclosure.viewHash,
          expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
        });
      } catch (e) {
        // A changed record needs fresh approval. Refresh the preview, but never
        // automatically retry creation with a hash the person has not reviewed.
        if ((e as { code?: string }).code === "DISCLOSURE_PREVIEW_CHANGED") {
          await loadPreview();
          throw new Error("This Proof has changed. Review the updated preview, then share again.");
        }
        throw e;
      }
      if(app.session?.userId)void recordNativeStudyInteraction(app.client,app.session.userId,"share_created").catch(()=>undefined);
      setLink(currentLink);
      setLinks((current) => [currentLink!, ...current.filter((item) => item.accessLinkId !== currentLink!.accessLinkId)]);
    }
    if (!currentLink.url) throw new Error("The link is unavailable. Please reopen sharing and try again.");
    await Share.share({ message: `View this PackProof: ${currentLink.url}`, url: currentLink.url });
  }

  if (!proofId || !app.session) {
    return <AppScreen><AppHeader title="Share Proof" onBack={app.goBack} /></AppScreen>;
  }

  const activeLinks = links.filter((item) => !item.revokedAt && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
  const milestones = preview?.tracker.milestones.filter((item) => item.occurredAt && (!item.state || item.state === "COMPLETE")) ?? [];

  return (
    <AppScreen>
      <AppHeader title="Share Proof" onBack={app.goBack} />
      <Text style={[styles.body, { color: colors.textSecondary }]}>The same Proof for everyone who opens it.</Text>
      {error ? <Text accessibilityRole="alert" style={[styles.body, { color: colors.error }]}>{error}</Text> : null}
      {!preview ? (
        <InfoCard>
          {busy ? <ActivityIndicator color={colors.primary} accessibilityLabel="Loading Proof preview" /> : <Button label="Load preview" variant="secondary" onPress={() => void run(loadPreview)} />}
        </InfoCard>
      ) : (
        <FadeSlideIn>
          <InfoCard>
            <Text style={[styles.caption, { color: colors.textSecondary }]}>PROOF PREVIEW</Text>
            <Text style={[styles.title, { color: colors.textPrimary }]}>{preview.tracker.itemTitle || "Shipment Proof"}</Text>
            <StatusBadge label={preview.status === "EVIDENCE_COMMITTED" ? "Recording saved" : preview.status === "FINALIZED" ? "Proof finalized" : proofStatusLabel(preview.status)} tone="neutral" />
            <View style={styles.recordings}>
              {preview.evidence.length === 0 ? (
                <Text style={[styles.body, { color: colors.textSecondary }]}>No recordings saved yet.</Text>
              ) : preview.evidence.map((item) => {
                const uri = item.stageId
                  ? app.client.lifecycleEvidenceUrl(proofId, item.stageId, item.evidenceId)
                  : app.client.evidenceContentUrl(proofId, item.evidenceId);
                const expanded = openRecording === item.evidenceId;
                const playable = item.contentType.startsWith("video/") || item.contentType.startsWith("image/");
                return (
                  <View key={item.evidenceId} style={styles.recording}>
                    <PressableScale
                      disabled={!playable}
                      onPress={() => setOpenRecording(expanded ? null : item.evidenceId)}
                      accessibilityRole="button"
                      accessibilityLabel={item.label}
                      accessibilityState={{ expanded, disabled: !playable }}
                      style={styles.row}
                    >
                      <Ionicons name={item.contentType.startsWith("image/") ? "image-outline" : "videocam-outline"} size={20} color={colors.textSecondary} />
                      <Text style={[styles.rowLabel, { color: colors.textPrimary }]}>{item.label}</Text>
                      {playable ? <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={18} color={colors.textSecondary} /> : null}
                    </PressableScale>
                    {expanded && item.contentType.startsWith("image/") ? (
                      <Image source={{ uri, headers: app.client.authorizedDownloadHeaders() }} style={styles.image} resizeMode="contain" accessibilityLabel={item.label} />
                    ) : null}
                    {expanded && item.contentType.startsWith("video/") ? <RecordedVideo uri={uri} token={app.session!.token} /> : null}
                  </View>
                );
              })}
            </View>
            {milestones.length > 0 ? (
              <>
                <PressableScale onPress={() => setShowActivity(!showActivity)} accessibilityRole="button" accessibilityState={{ expanded: showActivity }} accessibilityLabel="Proof activity" style={[styles.row, { borderTopWidth: 1, borderTopColor: colors.divider }]}>
                  <Text style={[styles.rowLabel, { color: colors.textPrimary }]}>Activity</Text>
                  <Ionicons name={showActivity ? "chevron-up" : "chevron-down"} size={18} color={colors.textSecondary} />
                </PressableScale>
                {showActivity ? <FadeSlideIn><View style={styles.activity}>{milestones.map((item) => (
                  <View key={item.code} style={styles.activityItem}>
                    <Text style={[styles.body, { color: colors.textPrimary }]}>{item.label}</Text>
                    <Text style={[styles.caption, { color: colors.textSecondary }]}>{new Date(item.occurredAt!).toLocaleString()}</Text>
                  </View>
                ))}</View></FadeSlideIn> : null}
              </>
            ) : null}
          </InfoCard>
        </FadeSlideIn>
      )}
      <View style={styles.expiry}>
        <Text style={[styles.optionText, { color: colors.textPrimary }]}>Link expires in</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel="Link expires in" style={[styles.options, { backgroundColor: colors.surfacePressed }]}>
          {[1, 7, 30].map((value) => (
            <View key={value} style={styles.optionWrap}>
              <PressableScale disabled={busy} accessibilityRole="radio" accessibilityLabel={`${value} ${value === 1 ? "day" : "days"}`} accessibilityState={{ selected: days === value, checked: days === value, disabled: busy }} onPress={() => { setDays(value); setLink(null); }} style={[styles.option, { backgroundColor: days === value ? colors.surface : "transparent", borderColor: days === value ? colors.border : "transparent" }]}>
                <Text style={[styles.optionText, { color: days === value ? colors.textPrimary : colors.textSecondary }]}>{value} {value === 1 ? "day" : "days"}</Text>
              </PressableScale>
            </View>
          ))}
        </View>
      </View>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        Sharing lets anyone with the link view this Proof’s original recordings, including recordings and updates added later, until the link expires or you revoke it.
      </Text>
      <Button label="Share Proof" icon="share-outline" disabled={!preview || busy} loading={busy && Boolean(preview)} accessibilityHint="Approve this preview, create a viewing link, and choose where to share it" onPress={() => void run(shareProof)} />
      <PressableScale accessibilityRole="button" accessibilityLabel="Manage links" accessibilityState={{ expanded: showLinks, disabled: busy }} disabled={busy} onPress={() => {
        if (showLinks) setShowLinks(false);
        else void run(async () => { await reloadLinks(); setShowLinks(true); });
      }} style={styles.manage}>
        <Text style={[styles.optionText, { color: colors.textSecondary }]}>Manage links</Text>
        <Ionicons name={showLinks ? "chevron-up" : "chevron-down"} size={16} color={colors.textSecondary} />
      </PressableScale>
      {showLinks ? (
        <FadeSlideIn>
          <InfoCard>
            {activeLinks.length === 0 ? <Text style={[styles.body, { color: colors.textSecondary }]}>No active links.</Text> : <Text style={[styles.caption, { color: colors.textSecondary }]}>Revoking stops future access. It cannot remove copies someone has already saved.</Text>}
            {activeLinks.map((item) => (
              <View key={item.accessLinkId} style={[styles.link, { borderTopColor: colors.divider }]}>
                <Text style={[styles.body, { color: colors.textPrimary }]}>Created {new Date(item.createdAt).toLocaleDateString()}</Text>
                <Text style={[styles.caption, { color: colors.textSecondary }]}>{item.expiresAt ? `Expires ${new Date(item.expiresAt).toLocaleDateString()}` : "No expiry"}</Text>
                <Button label="Revoke link" variant="tertiary" disabled={busy} onPress={() => void run(async () => {
                  await app.client.revokeAccessLink(proofId, item.accessLinkId);
                  if (link?.accessLinkId === item.accessLinkId) setLink(null);
                  await reloadLinks();
                })} />
              </View>
            ))}
          </InfoCard>
        </FadeSlideIn>
      ) : null}
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.sectionTitle },
  body: { ...typography.secondary },
  caption: { ...typography.caption },
  recordings: { marginTop: spacing.sm, gap: spacing.sm },
  recording: { gap: spacing.sm },
  image: { width: "100%", height: 220, borderRadius: radii.md },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: sizes.touch, paddingVertical: spacing.sm },
  rowLabel: { ...typography.secondaryStrong, flex: 1 },
  activity: { gap: spacing.md },
  activityItem: { gap: spacing.xs },
  expiry: { gap: spacing.sm },
  options: { flexDirection: "row", padding: spacing.xs, borderRadius: radii.md, gap: spacing.xs },
  optionWrap: { flex: 1 },
  option: { minHeight: sizes.touch, justifyContent: "center", alignItems: "center", borderRadius: radii.sm, borderWidth: 1, paddingHorizontal: spacing.xs },
  optionText: { ...typography.secondaryStrong },
  manage: { flexDirection: "row", gap: spacing.sm, alignItems: "center", justifyContent: "center", minHeight: sizes.touch },
  link: { gap: spacing.xs, paddingTop: spacing.md, borderTopWidth: 1 },
});
