import { useVideoPlayer, VideoView } from "expo-video";
import { View } from "react-native";
import { Button } from "./Button";
export function RecordedVideo({ uri, token, labelOffsetMs }: { uri: string; token: string; labelOffsetMs?: number }) {
  const player = useVideoPlayer({ uri, headers: { Authorization: `Bearer ${token}` } }, (video) => {
    video.loop = false;
  });
  return (
    <View style={{gap:8}}>
    <VideoView
      player={player}
      style={{ width: "100%", height: 240, borderRadius: 12 }}
      nativeControls
      allowsFullscreen
      contentFit="contain"
    />
    {labelOffsetMs !== undefined ? <Button label="Replay shipping label" variant="secondary" onPress={()=>{player.currentTime=Math.max(0,labelOffsetMs/1000-0.5);player.play();}} /> : null}
    </View>
  );
}
