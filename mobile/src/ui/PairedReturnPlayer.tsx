import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";
import { Button } from "./Button";
import { useTheme } from "../theme/ThemeProvider";
import { elapsedLabel, type EvidenceAnchor } from "../signature";

export function PairedReturnPlayer({
  outboundUri,
  incomingUri,
  token,
  outbound,
  incoming,
}: {
  outboundUri: string;
  incomingUri: string;
  token: string;
  outbound: EvidenceAnchor;
  incoming: EvidenceAnchor;
}) {
  const { colors } = useTheme(),
    [linked, setLinked] = useState(true),
    [zoom, setZoom] = useState(false);
  const left = useVideoPlayer(
    { uri: outboundUri, headers: { Authorization: `Bearer ${token}` } },
    (player) => {
      player.muted = true;
      player.timeUpdateEventInterval = 0.25;
    },
  );
  const right = useVideoPlayer(
    { uri: incomingUri, headers: { Authorization: `Bearer ${token}` } },
    (player) => {
      player.muted = true;
    },
  );
  const align = () => {
    left.currentTime = outbound.startMs / 1000;
    right.currentTime = incoming.startMs / 1000;
  };
  useEffect(() => {
    align();
  }, [outbound.anchorId, incoming.anchorId, left, right]);
  useEffect(() => {
    if (!linked) return;
    const time = left.addListener("timeUpdate", ({ currentTime }) => {
      const target = Math.max(
        0,
        incoming.startMs / 1000 + currentTime - outbound.startMs / 1000,
      );
      if (right.duration > 0 && target >= right.duration) {
        right.pause();
        return;
      }
      if (Math.abs(right.currentTime - target) > 0.5)
        right.currentTime = target;
    });
    const playing = left.addListener("playingChange", ({ isPlaying }) => {
      if (isPlaying) right.play();
      else right.pause();
    });
    return () => {
      time.remove();
      playing.remove();
    };
  }, [linked, outbound.anchorId, incoming.anchorId, left, right]);
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ color: colors.textPrimary }}>
        Outbound · {outbound.label} · {elapsedLabel(outbound.startMs)}
      </Text>
      <View style={{ overflow: "hidden", borderRadius: 12 }}>
        <VideoView
          player={left}
          style={{
            width: "100%",
            height: 220,
            transform: [{ scale: zoom ? 1.5 : 1 }],
          }}
          contentFit="contain"
          nativeControls
          allowsFullscreen
        />
      </View>
      <Text style={{ color: colors.textPrimary }}>
        Incoming · {incoming.label} · {elapsedLabel(incoming.startMs)}
      </Text>
      <View style={{ overflow: "hidden", borderRadius: 12 }}>
        <VideoView
          player={right}
          style={{
            width: "100%",
            height: 220,
            transform: [{ scale: zoom ? 1.5 : 1 }],
          }}
          contentFit="contain"
          nativeControls
          allowsFullscreen
        />
      </View>
      <Text style={{ color: colors.textSecondary }}>
        Paired inspection is a presentation aid. Use the outbound controls when
        linked. Each time belongs to its own original.
      </Text>
      <Button
        label="Align selected moments"
        variant="secondary"
        onPress={align}
      />
      <Button
        label={linked ? "Unlink playback" : "Link playback"}
        variant="secondary"
        onPress={() => setLinked(!linked)}
      />
      <Button
        label={zoom ? "Show full frames" : "Inspect at 150%"}
        variant="secondary"
        onPress={() => setZoom(!zoom)}
      />
    </View>
  );
}
