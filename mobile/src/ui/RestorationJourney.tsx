import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePackProof } from '../app/PackProofProvider';
import type { ProofRecordTab } from '../copy/proof-record';
import { proofDisplayTitle } from '../copy/proof-title';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { Button } from './Button';
import { PressableScale, StateTransition } from './motion';
import { UploadRecoveryCards } from './UploadRecoveryCards';

type Destination='Capture'|'Evidence'|'Tools';
/** The review slice composes existing command and evidence owners; it owns no evidence state. */
export function RestorationJourney({action,completed,renderEvidence}:{action:ReactNode;completed:boolean;renderEvidence:(tab:ProofRecordTab)=>ReactNode}) {
  const app=usePackProof(),{colors}=useTheme(),proof=app.proof!;
  const initial=app.readProofRecordView(proof.proofId);
  const [destination,setDestination]=useState<Destination>(initial.tab==='Timeline'||initial.tab==='Tracking'?'Evidence':initial.journey??'Capture');
  const [evidenceTab,setEvidenceTab]=useState<ProofRecordTab>(initial.tab==='Receipt'?'Evidence':initial.tab);
  function select(next:Destination,tab:ProofRecordTab='Evidence') {
    setDestination(next);setEvidenceTab(tab);
    app.saveProofRecordView(proof.proofId,{...app.readProofRecordView(proof.proofId),journey:next,tab});
  }
  const eventKey=[proof.proofId,proof.status,proof.nextAction?.type,proof.nextAction?.assetId,
    ...app.photoDrafts.filter(d=>d.proofId===proof.proofId).map(d=>d.phase+':'+d.slots.filter(s=>s.sha256).length),
    ...app.savedRecordings.filter(c=>c.captureProofId===proof.proofId).map(c=>c.recovery?.phase)].join(':');
  const tools=[['ask','Find evidence','Search original sources and inspect source-linked results.','search-outline'],
    ['compare','Compare recordings','Inspect packing and receiving originals side by side.','git-compare-outline'],
    ['case','Build a case packet','Choose sources, add factual notes, then preview and export.','document-text-outline'],
    ['history','Item history','View, share selected entries, or open shared history.','time-outline']] as const;
  return <View style={[styles.root,{backgroundColor:colors.surface}]}>
    <View style={styles.heading}><Text accessibilityRole="header" style={[typography.pageTitle,{color:colors.textPrimary}]}>{proofDisplayTitle(proof)}</Text>
      <Text style={[typography.secondary,{color:colors.textSecondary}]}>{proof.transaction.externalReference?`Order ${proof.transaction.externalReference}`:'Your item and packing record'}</Text></View>
    <View accessibilityRole="tablist" accessibilityLabel="Proof destinations" style={[styles.tabs,{borderBottomColor:colors.divider}]}>
      {(['Capture','Evidence','Tools'] as const).map(tab=><View key={tab} style={{flex:1,minWidth:0}}><PressableScale accessibilityRole="tab" accessibilityLabel={tab} accessibilityState={{selected:destination===tab}} onPress={()=>select(tab)} style={[styles.tab,{borderBottomColor:destination===tab?colors.accent:'transparent'}]}>
        <Text style={[typography.bodyStrong,{color:destination===tab?colors.accentText:colors.textSecondary,textAlign:'center'}]}>{tab}</Text>
      </PressableScale></View>)}
    </View>
    {destination==='Evidence'?<View style={styles.root}>
      <View style={styles.evidenceOptions}><Button label="Originals" variant="tertiary" onPress={()=>select('Evidence')} /><Button label="Activity" variant="tertiary" onPress={()=>select('Evidence','Timeline')} /><Button label="Shipment" variant="tertiary" onPress={()=>select('Evidence','Tracking')} /></View>
      {renderEvidence(evidenceTab)}
    </View>:<ScrollView contentContainerStyle={styles.body}>
      {destination==='Capture'?<StateTransition eventKey={eventKey} style={styles.task}>
        {completed?<>
          <Ionicons name="checkmark-circle-outline" size={54} color={colors.successText} />
          <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={[styles.title,{color:colors.textPrimary}]}>Evidence saved to PackProof.</Text>
          <Text style={[typography.body,{color:colors.textSecondary}]}>Your Proof is finalized. Inspect each original and its availability in Evidence.</Text>
          <Button label="View evidence" onPress={()=>select('Evidence')} />
          <Text style={[typography.secondary,{color:colors.textSecondary}]}>Any recipient work is separate from your finalized evidence.</Text>
          {action}
        </>:<><UploadRecoveryCards />{action||<><Text accessibilityRole="header" style={[styles.title,{color:colors.textPrimary}]}>Check your evidence</Text><Text style={[typography.body,{color:colors.textSecondary}]}>Inspect saved originals and pending work in this Proof.</Text><Button label="View evidence" onPress={()=>select('Evidence')} /></>}</>}
      </StateTransition>:<View style={styles.task}><Text accessibilityRole="header" style={[styles.title,{color:colors.textPrimary}]}>Use this evidence</Text>
        {tools.map(([key,title,copy,icon])=><PressableScale key={key} accessibilityRole="button" accessibilityLabel={title} onPress={()=>app.go('signature',{signatureTool:key})} style={[styles.tool,{borderBottomColor:colors.divider}]}>
          <Ionicons name={icon} size={24} color={colors.accentText}/><View style={styles.toolCopy}><Text style={[typography.bodyStrong,{color:colors.textPrimary}]}>{title}</Text><Text style={[typography.secondary,{color:colors.textSecondary}]}>{copy}</Text></View>
        </PressableScale>)}
      </View>}
    </ScrollView>}
  </View>;
}
const styles=StyleSheet.create({root:{flex:1},heading:{padding:20,gap:6},tabs:{flexDirection:'row',justifyContent:'space-around',borderBottomWidth:1},tab:{minHeight:52,padding:12,borderBottomWidth:3},body:{padding:20,paddingBottom:36},task:{gap:18},title:{...typography.pageTitle,fontSize:28,lineHeight:35},tool:{flexDirection:'row',alignItems:'center',gap:14,paddingVertical:18,borderBottomWidth:1},toolCopy:{flex:1,gap:6},evidenceOptions:{flexDirection:'row',flexWrap:'wrap',gap:8,paddingHorizontal:16}});
