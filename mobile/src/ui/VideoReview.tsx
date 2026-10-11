import { useVideoPlayer, VideoView } from "expo-video";

export function VideoReview({ uri, compact = false, accessibilityLabel = "Saved recording. Play to review before confirming submission." }: { uri: string | number; compact?: boolean; accessibilityLabel?: string }) {
  const player = useVideoPlayer(uri, (video) => {
    video.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={{ width: "100%", height: compact ? 144 : 200, borderRadius: 12 }}
      nativeControls
      allowsFullscreen
      contentFit="contain"
      accessibilityLabel={accessibilityLabel}
    />
  );
}
