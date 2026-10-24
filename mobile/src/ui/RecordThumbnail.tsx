import { useState } from 'react';
import { Image, View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
export function RecordThumbnail({ proofId, derivativeId,large=false }: { proofId: string; derivativeId?: string | null;large?:boolean }) {
  const app=usePackProof(), {colors}=useTheme();
  const identity=JSON.stringify([app.apiBaseUrl,app.session?.userId,proofId,derivativeId]);
  const [failedKey,setFailedKey]=useState<string|null>(null);
  const failed=failedKey===identity;
  return <View style={[styles.frame,large&&{width:"100%",height:152,borderRadius:16},{backgroundColor:colors.surfaceElevated}]} accessibilityLabel={derivativeId&&!failed?'Preview from the packing recording':'Recording preview unavailable'}>
    {derivativeId&&!failed ? <Image key={identity} source={{uri:app.client.thumbnailUrl(proofId,derivativeId),headers:app.client.authorizedDownloadHeaders()}} style={styles.image} onError={()=>setFailedKey(identity)} /> : <Ionicons name="videocam-outline" size={26} color={colors.textSecondary}/>}
    <View style={styles.play}><Ionicons name="play" size={10} color="#FFFFFF"/></View>
  </View>;
}
const styles=StyleSheet.create({frame:{width:76,height:84,borderRadius:10,overflow:'hidden',alignItems:'center',justifyContent:'center'},image:{width:'100%',height:'100%'},play:{position:'absolute',bottom:7,left:7,width:22,height:22,borderRadius:11,backgroundColor:'#23262D',alignItems:'center',justifyContent:'center'}});
