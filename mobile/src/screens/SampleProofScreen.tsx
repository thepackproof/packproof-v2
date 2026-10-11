import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { AppScreen } from "../ui/AppScreen";
import { AppHeader } from "../ui/AppHeader";
import { Button } from "../ui/Button";
import { VideoReview } from "../ui/VideoReview";
import { ProofRecordTimeline } from "../ui/ProofRecordTimeline";
import { sampleChronology } from "../../../packages/first-proof/sample";
import { useTheme } from "../theme/ThemeProvider";
import { typography } from "../theme/tokens";

/** Public, bundled fixture. No account, domain command, sharing grant or analytics operation. */
export function SampleProofScreen({onClose}:{onClose:()=>void}) {
  const {colors}=useTheme();
  const [activity,setActivity]=useState(false),[filter,setFilter]=useState("MILESTONES"),[detail,setDetail]=useState<string|null>(null);
  return <AppScreen extraBottom={24}>
    <AppHeader title="Sample Proof" onBack={onClose}/>
    <View style={[styles.card,{backgroundColor:colors.accentSoft,borderColor:colors.accentSoftBorder}]}>
      <Text style={[styles.title,{color:colors.textPrimary}]}>Ceramic mug · fictional order #1042</Text>
      <Text style={[styles.body,{color:colors.textSecondary}]}>SAMPLE ONLY · No customer data</Text>
      <Text style={[styles.body,{color:colors.textSecondary}]}>Explore an illustrative record. This sample creates no Proof, uses no credits, and cannot be shared as live evidence.</Text>
    </View>
    <View style={styles.tabs}><Button label="Recording" variant={activity?"tertiary":"secondary"} onPress={()=>{setActivity(false);setDetail(null);}}/><Button label="Activity" variant={activity?"secondary":"tertiary"} onPress={()=>{setActivity(true);setDetail(null);}}/></View>
    {activity ? <><Text style={[styles.body,{color:colors.textSecondary}]}>Illustrative events, including a fictional finalization. They do not report a real finalized Proof.</Text><ProofRecordTimeline entries={sampleChronology} finalizedAt="2026-09-01T09:46:00Z" filter={filter} onFilter={setFilter} onSelect={entry=>setDetail(entry.description)}/>{detail?<Text style={[styles.body,{color:colors.textSecondary}]}>{detail}</Text>:null}</> : <>
      <VideoReview uri={require("../../../web/public/sample-packing.mp4")} accessibilityLabel="Illustrative stock packing footage. This is not a PackProof customer recording."/>
      <Text style={[styles.body,{color:colors.textSecondary}]}>The clip shows packing material, a ceramic mug, and the mug placed in a box. No final seal, shipping label or carrier handoff is shown.</Text>
      <Text style={[styles.body,{color:colors.textSecondary}]}>MART PRODUCTION / Pexels · licensed stock footage. Fictional order details; not recorded through PackProof.</Text>
    </>}
    <Text style={[styles.body,{color:colors.textSecondary}]}>A real Proof keeps your original recording and its saved history together. Access follows its actual sharing grants. PackProof does not decide authenticity, fault, or claim outcomes.</Text>
    <Button label="Close sample" variant="secondary" onPress={onClose}/>
  </AppScreen>;
}
const styles=StyleSheet.create({card:{borderWidth:1,borderRadius:12,padding:16,gap:8},title:{...typography.sectionTitle},body:{...typography.body},tabs:{flexDirection:"row",flexWrap:"wrap",gap:12}});
