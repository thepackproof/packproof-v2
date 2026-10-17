import { useState } from 'react';
import { Text, View } from 'react-native';
import type { LocalCapture } from '../capture';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from './Button';
import { VideoReview } from './VideoReview';

/** Read-only inspection from the account-scoped recovery list; no submit or camera command. */
export function RetainedRecordingInspection({capture}:{capture:LocalCapture}) {
  const [visible,setVisible]=useState(false),{colors}=useTheme();
  if(capture.localFileAvailable===false)return null;
  return <View style={{gap:12}}>
    <Button label={visible?'Hide surviving video':'Inspect surviving video'} variant="secondary" onPress={()=>setVisible(!visible)} />
    {visible?<VideoReview key={capture.uri} uri={capture.uri} inspection accessibilityLabel="Surviving recording, inspection only. This is not accepted continuous evidence."/>:null}
    <Text style={[typography.secondary,{color:colors.textSecondary}]}>The original stays on this device. Playback does not establish a complete continuous take. File and recovery options let you export it or deliberately discard it.</Text>
  </View>;
}
