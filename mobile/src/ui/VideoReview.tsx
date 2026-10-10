import { useVideoPlayer, VideoView } from "expo-video";

export function VideoReview({ uri, compact = false }: { uri: string; compact?: boolean }) {
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
      accessibilityLabel="Saved recording. Play to review before confirming submission."
    />
  );
}
