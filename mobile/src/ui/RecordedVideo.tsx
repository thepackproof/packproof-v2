import { useVideoPlayer, VideoView } from "expo-video";
export function RecordedVideo({ uri, token }: { uri: string; token: string }) {
  const player = useVideoPlayer({ uri, headers: { Authorization: `Bearer ${token}` } }, (video) => {
    video.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={{ width: "100%", height: 240, borderRadius: 12 }}
      nativeControls
      allowsFullscreen
      contentFit="contain"
    />
  );
}
