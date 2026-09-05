import { useEffect, useState } from "react";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { useTheme } from "../theme/ThemeProvider";
import { Button } from "./Button";
import { elapsedLabel, type EvidenceAnchor } from "../signature";

export function SignaturePlayer({
  uri,
  token,
  anchors,
  selection,
  onMoment,
  thumbnails,
  title = "Original recording",
}: {
  uri: string;
  token: string;
  anchors: EvidenceAnchor[];
  selection?: EvidenceAnchor | null;
  onMoment?: (timeMs: number) => void;
  title?: string;
  thumbnails?: Record<string, string>;
}) {
  const { colors } = useTheme();
  const [playbackError, setPlaybackError] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const player = useVideoPlayer(
    { uri, headers: { Authorization: `Bearer ${token}` } },
    (video) => {
      video.loop = false;
    },
  );
  useEffect(() => {
    const subscription = player.addListener("statusChange", ({ status }) =>
      setPlaybackError(status === "error"),
    );
    return () => subscription.remove();
  }, [player]);
  const seek = (anchor: EvidenceAnchor) => {
    player.currentTime = anchor.startMs / 1000;
    setSelected(anchor.anchorId);
    player.play();
  };
  useEffect(() => {
    if (selection) seek(selection);
  }, [selection?.anchorId, player]);
  return (
    <View style={{ gap: 10 }}>
      <Text style={{ color: colors.textPrimary, fontWeight: "600" }}>
        {title}
      </Text>
      <VideoView
        player={player}
        style={styles.video}
        nativeControls
        allowsFullscreen
        contentFit="contain"
      />
      {playbackError ? (
        <Text accessibilityRole="alert" style={{ color: colors.error }}>
          Original playback could not load. Refresh authorization or retry when
          connected. No replacement footage is shown.
        </Text>
      ) : null}
      <Text style={{ color: colors.textSecondary }}>
        Chapters point to the original recording. Times are elapsed video time.
      </Text>
      <ScrollView
        horizontal
        contentContainerStyle={{ gap: 10 }}
        accessibilityLabel="Original recording chapters"
      >
        {anchors.map((anchor) => (
          <View key={anchor.anchorId} style={{ width: 200, gap: 8 }}>
            {thumbnails?.[anchor.anchorId] ? (
              <Image
                source={{
                  uri: thumbnails[anchor.anchorId],
                  headers: { Authorization: `Bearer ${token}` },
                }}
                style={{ width: 200, height: 112, borderRadius: 8 }}
                resizeMode="contain"
                accessibilityLabel={`${anchor.label} original frame`}
              />
            ) : null}
            <Button
              label={`${selected === anchor.anchorId ? "Playing · " : ""}${elapsedLabel(anchor.startMs)} · ${anchor.label}`}
              variant="secondary"
              onPress={() => seek(anchor)}
            />
          </View>
        ))}
      </ScrollView>
      {!anchors.length ? (
        <Text style={{ color: colors.textSecondary }}>
          No indexed moments yet. The complete original remains playable.
        </Text>
      ) : null}
      {onMoment ? (
        <Button
          label="Bookmark current moment"
          variant="secondary"
          onPress={() => {
            player.pause();
            onMoment(Math.round(player.currentTime * 1000));
          }}
        />
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create({
  video: { width: "100%", height: 240, borderRadius: 12 },
});
