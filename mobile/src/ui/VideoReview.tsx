import { useVideoPlayer, VideoView } from "expo-video";

export function VideoReview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (video) => {
    video.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={{ width: "100%", height: 200, borderRadius: 12 }}
      nativeControls
      allowsFullscreen
      contentFit="contain"
    />
  );
}
