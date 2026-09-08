import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Modal, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import { usePackProof } from "../app/PackProofProvider";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";
import { elapsedLabel, type EvidenceAnchor } from "../signature";
import type { RecordEvidence } from "../copy/proof-record";
import { Button, IconButton } from "./Button";
import { PressableScale } from "./motion";

export function ProofEvidencePreview({ evidence, title, bookmarks, labelOffsetMs, active = true, initialTime = 0, onTime }: {
  evidence: RecordEvidence;
  title: string;
  active?: boolean;
  bookmarks: EvidenceAnchor[];
  labelOffsetMs?: number;
  initialTime?: number;
  onTime?: (seconds: number) => void;
}) {
  const app = usePackProof(), { colors } = useTheme();
  const [downloading, setDownloading] = useState(false), [downloadError, setDownloadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false), [imageError, setImageError] = useState(false);
  const [playbackAttempt, setPlaybackAttempt] = useState(0), [retrying, setRetrying] = useState(false);
  const playbackPosition = useRef(initialTime);
  const [imageRatio, setImageRatio] = useState(1);
  const dimensions = useWindowDimensions();
  useEffect(() => { if (!active) setExpanded(false); }, [active]);
  const lock = useRef(false);
  const contentType = (evidence.contentType ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  // Both routes authorize access and verify the stored original against its committed digest.
  const uri = evidence.stageId
    ? app.client.lifecycleEvidenceUrl(app.proof!.proofId, evidence.stageId, evidence.evidenceId)
    : app.client.evidenceContentUrl(app.proof!.proofId, evidence.evidenceId);
  const video = contentType.startsWith("video/"), picture = contentType.startsWith("image/");
  const token = app.session!.token;
  async function retryPlayback() {
    if (retrying) return;
    setRetrying(true); setDownloadError(null);
    try {
      await app.ensureAuth();
      // Recreate the player with the refreshed session; the prior native player may already be released.
      setPlaybackAttempt(value => value + 1);
    } catch {
      setDownloadError("Playback authorization could not be refreshed. Sign in again or retry when connected.");
    } finally { setRetrying(false); }
  }
  async function download() {
    if (lock.current) return;
    lock.current = true;
    setDownloading(true); setDownloadError(null);
    let destination: string | null = null;
    try {
      await app.ensureAuth();
      if (!FileSystem.cacheDirectory || !(await Sharing.isAvailableAsync())) throw new Error("Saving this file is unavailable on this device.");
      const extensions: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
      destination = `${FileSystem.cacheDirectory}packproof-${evidence.evidenceId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${extensions[contentType] ?? "bin"}`;
      const result = await FileSystem.downloadAsync(uri, destination, { headers: app.client.authorizedDownloadHeaders() });
      if (result.status < 200 || result.status >= 300) throw new Error("The original could not be downloaded. Check your connection and try again.");
      await Sharing.shareAsync(result.uri, { mimeType: contentType, dialogTitle: "Save original evidence" });
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "The original could not be downloaded.");
    } finally {
      if (destination) await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
      lock.current = false; setDownloading(false);
    }
  }
  return <View style={styles.stack}>
    <View style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surfaceElevated }]}>
      <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
        <View style={styles.heading}><Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text></View>
        <IconButton label="Save original evidence" onPress={() => void download()} disabled={downloading}>{downloading ? <ActivityIndicator color={colors.accent} /> : <Ionicons name="download-outline" size={23} color={colors.textPrimary} />}</IconButton>
      </View>
      {video ? <OriginalVideo key={playbackAttempt} uri={uri} token={token} active={active} bookmarks={bookmarks} labelOffsetMs={labelOffsetMs} initialTime={playbackPosition.current} onTime={seconds => { playbackPosition.current = seconds; onTime?.(seconds); }} onRetry={() => void retryPlayback()} retrying={retrying} /> : picture ? <View style={styles.canvas}>
        <PressableScale onPress={() => setExpanded(true)} accessibilityRole="button" accessibilityLabel="Expand original image">
          <Image source={{ uri, headers: { Authorization: `Bearer ${token}` } }} style={[styles.image, { aspectRatio: imageRatio, maxHeight: dimensions.height * 0.6 }]} onLoad={event => { const { width, height } = event.nativeEvent.source; if (width > 0 && height > 0) setImageRatio(width / height); }} resizeMode="contain" accessibilityLabel={title} onError={() => setImageError(true)} />
        </PressableScale>
        {imageError ? <Text style={[styles.meta, { color: colors.error }]}>The image could not load. Refresh the Proof or save the original to view it.</Text> : <Text style={[styles.meta, { color: colors.textSecondary }]}>Tap the image to expand.</Text>}
      </View> : <View style={styles.canvas}><Text style={[styles.meta, { color: colors.textSecondary }]}>Save the original to open this file on your device.</Text><Button label="Save original" variant="secondary" loading={downloading} onPress={() => void download()} /></View>}
    </View>
    {downloadError ? <Text accessibilityRole="alert" style={[styles.meta, { color: colors.error }]}>{downloadError}</Text> : null}
    <Modal visible={expanded} animationType="fade" onRequestClose={() => setExpanded(false)}><View style={[styles.expanded, { backgroundColor: colors.background }]}><Button label="Close image" variant="secondary" onPress={() => setExpanded(false)} /><Image source={{ uri, headers: { Authorization: `Bearer ${token}` } }} style={styles.fullImage} resizeMode="contain" accessibilityLabel={title} /></View></Modal>
  </View>;
}

function OriginalVideo({ uri, token, active, bookmarks, labelOffsetMs, initialTime, onTime, onRetry, retrying }: { uri: string; token: string; active: boolean; bookmarks: EvidenceAnchor[]; labelOffsetMs?: number; initialTime: number; onTime?: (seconds: number) => void; onRetry: () => void; retrying: boolean }) {
  const { colors } = useTheme();
  const [selected, setSelected] = useState<string | null>(null), [error, setError] = useState(false);
  const restored = useRef(false), timeCallback = useRef(onTime);
  timeCallback.current = onTime;
  const player = useVideoPlayer({ uri, headers: { Authorization: `Bearer ${token}` } }, video => { video.loop = false; video.timeUpdateEventInterval = 0.5; });
  useEffect(() => {
    restored.current = false;
    const restore = () => {
      if (!restored.current && player.status === "readyToPlay") {
        restored.current = true;
        player.currentTime = Math.max(0, Math.min(initialTime, player.duration || initialTime));
      }
    };
    const subscription = player.addListener("statusChange", ({ status }) => { setError(status === "error"); restore(); });
    const position = player.addListener("timeUpdate", ({ currentTime }) => {
      if (restored.current && Number.isFinite(currentTime)) timeCallback.current?.(currentTime);
    });
    restore();
    return () => { subscription.remove(); position.remove(); };
  }, [player]);
  useEffect(() => { if (!active) player.pause(); }, [active, player]);
  function seek(key: string, startMs: number) {
    player.currentTime = Math.max(0, startMs / 1000);
    setSelected(key); player.play();
  }
  const scannerBookmark = Number.isFinite(labelOffsetMs) && labelOffsetMs! >= 0 && !bookmarks.some(anchor => anchor.sourceType === "SCANNER_TRIGGERED" && Math.abs(anchor.startMs - labelOffsetMs!) < 1000);
  return <View style={styles.canvas}>
    <VideoView player={player} style={styles.video} nativeControls allowsFullscreen contentFit="contain" accessibilityLabel="Original evidence recording" />
    {error ? <View style={styles.stack}><Text accessibilityRole="alert" style={[styles.meta, { color: colors.error }]}>The original recording could not load. Check your connection and retry.</Text><Button label="Retry original playback" variant="secondary" onPress={onRetry} loading={retrying} /></View> : null}
    {bookmarks.length || scannerBookmark ? <View style={styles.bookmarks} accessibilityLabel="Original recording bookmarks">
      {bookmarks.map(anchor => <PressableScale key={anchor.anchorId} accessibilityRole="button" accessibilityState={{ selected: selected === anchor.anchorId }} accessibilityLabel={`Play ${anchor.label} at ${elapsedLabel(anchor.startMs)}`} onPress={() => seek(anchor.anchorId, anchor.startMs)} style={[styles.bookmark, { backgroundColor: colors.accentSoft, borderColor: selected === anchor.anchorId ? colors.accent : colors.accentSoftBorder }]}>
        <Text style={[styles.bookmarkLabel, { color: colors.accentText }]}>{elapsedLabel(anchor.startMs)} · {anchor.label}</Text>
        <Text style={[styles.caption, { color: colors.textSecondary }]}>{anchor.sourceType === "SCANNER_TRIGGERED" ? "Capture label observation" : "Marked by a participant"}</Text>
      </PressableScale>)}
      {scannerBookmark ? <PressableScale accessibilityRole="button" accessibilityLabel={`Replay shipping label at ${elapsedLabel(labelOffsetMs!)}`} onPress={() => seek("shipping-label", labelOffsetMs!)} style={[styles.bookmark, { backgroundColor: colors.accentSoft, borderColor: selected === "shipping-label" ? colors.accent : colors.accentSoftBorder }]}><Text style={[styles.bookmarkLabel, { color: colors.accentText }]}>{elapsedLabel(labelOffsetMs!)} · Label read during capture</Text><Text style={[styles.caption, { color: colors.textSecondary }]}>Capture label observation</Text></PressableScale> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  stack: { gap: 12 }, card: { borderRadius: 12, overflow: "hidden" },
  toolbar: { flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 4, alignItems: "center" },
  fileIcon: { width: 40, height: 44, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  heading: { flex: 1, gap: 4 }, title: { ...typography.bodyStrong }, meta: { ...typography.secondary }, caption: { ...typography.caption },
  canvas: { padding: 8, gap: 12 }, video: { width: "100%", aspectRatio: 16 / 9, backgroundColor: "#000", borderRadius: 10 },
  image: { width: "100%", borderRadius: 10 }, bookmarks: { gap: 8, flexDirection: "row", flexWrap: "wrap" },
  bookmark: { padding: 12, gap: 4, minHeight: 48, borderRadius: 10, borderWidth: 1 }, bookmarkLabel: { ...typography.body },
  expanded: { flex: 1, padding: 24, paddingTop: 56, gap: 16 }, fullImage: { flex: 1, width: "100%" },
});
