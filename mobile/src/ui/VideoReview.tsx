import {SIGNAL_ENABLED} from "../experience/signal";
import { useVideoPlayer, VideoView } from "expo-video";
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';

export function VideoReview({ uri, compact = false, inspection = false, accessibilityLabel = "Saved recording. Play to review before confirming submission." }: { uri: string | number; compact?: boolean; inspection?: boolean; accessibilityLabel?: string }) {
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  const player = useVideoPlayer(uri, (video) => {
    video.loop = false;
  });
  useEffect(() => {
    setFailed(player.status === 'error');
    const subscription=player.addListener('statusChange',({status})=>setFailed(status==='error'));
    return () => subscription.remove();
  },[player,uri]);
  return (
    <>
    <VideoView
      player={player}
      style={{ width: "100%", height: SIGNAL_ENABLED ? 250 : compact ? 144 : 200, borderRadius: SIGNAL_ENABLED?16:12, backgroundColor:"#18221F" }}
      nativeControls
      allowsFullscreen
      contentFit="contain"
      accessibilityLabel={accessibilityLabel}
    />
    {inspection && failed ? <Text accessibilityRole="alert" style={{color:colors.warningText,fontSize:14,lineHeight:21}}>This device could not play the surviving file. It remains saved; export it from recovery options for inspection. It has not been accepted as complete evidence.</Text> : null}
    </>
  );
}
