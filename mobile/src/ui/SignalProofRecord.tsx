import {useEffect,useState,type ReactNode} from 'react';
import {ScrollView,View} from 'react-native';
import {usePackProof} from '../app/PackProofProvider';
import {useTheme} from '../theme/ThemeProvider';
import {committedRecordEvidence,recordEvidenceKey,recordEvidenceLabel} from '../copy/proof-record';
import {presentationForProof} from '../copy/proof-list';
import {hasSignalReceipt} from '../experience/signal/receipt';
import {SignalText,SignalBadge} from './Signal';
import {ProofEvidencePreview} from './ProofEvidencePreview';
import {ProofRecord} from './ProofRecord';
import {Button} from './Button';
import {SharingScreen} from '../screens/SharingScreen';
import {SELLER_SHIPPING_STATEMENT} from '../attestation/statement';
export function SignalProofRecord({action}:{action:ReactNode}){
 const app=usePackProof(),{colors}=useTheme();const proof=app.proof!;
 const [details,setDetails]=useState(false),[sharing,setSharing]=useState(false),[saved,setSaved]=useState<string|null>(null);
 const evidence=committedRecordEvidence(proof);const selected=evidence.find(row=>!row.stageId&&row.contentType?.startsWith('video/'))||evidence[0];
 const presentation=presentationForProof(proof,app.role);const owner=`${app.apiBaseUrl}:${app.session?.userId}:${proof.proofId}:${proof.version}`;
 useEffect(()=>{let active=true;setSaved(null);if(selected)void app.client.getProofRecovery(proof.proofId).then(recovery=>{if(active&&hasSignalReceipt(proof,recovery,{proofId:proof.proofId,evidenceId:selected.evidenceId}))setSaved(owner);}).catch(()=>{});return()=>{active=false;};},[owner,selected?.evidenceId,app.client]);
 const statement=proof.attestations?.find(row=>row.statement==='PACKED_DESCRIBED_ITEM'&&row.relatedEvidenceId===selected?.evidenceId);
 if(details)return <View style={{flex:1,gap:12}}><Button label="Back to your Proof" variant="tertiary" onPress={()=>setDetails(false)}/><ProofRecord key={proof.proofId} statusLabel={presentation.displayStatus} action={action}/></View>;
 return <><ScrollView contentContainerStyle={{gap:20,paddingBottom:24}} keyboardShouldPersistTaps="handled"><SignalBadge state={saved===owner?'saved':'local'}>{saved===owner?'Saved to PackProof':proof.status==='FINALIZED'?'Recording received':presentation.displayStatus}</SignalBadge><SignalText kind="mono" muted>{proof.transaction.externalReference||proof.proofId}</SignalText><SignalText kind="title">{proof.transaction.itemTitle||'Packing record'}</SignalText><SignalText muted>{[proof.transaction.itemDescription,new Date(proof.createdAt).toLocaleDateString()].filter(Boolean).join(' · ')}</SignalText>{action}{selected?<><ProofEvidencePreview key={recordEvidenceKey(selected)} evidence={selected} title={recordEvidenceLabel(selected)} bookmarks={[]}/><SignalText kind="small" muted>Packing recording · Original</SignalText></>:<SignalText muted>No recording has been saved to this Proof yet.</SignalText>}{statement&&<View style={{borderTopWidth:1,borderBottomWidth:1,borderColor:colors.border,paddingVertical:20,gap:8}}><SignalText kind="mono" muted>PACKING CONFIRMATION</SignalText><SignalText kind="strong">{SELLER_SHIPPING_STATEMENT}</SignalText><SignalText kind="small" muted>Recorded {new Date(statement.createdAt).toLocaleString()}</SignalText></View>}{presentation.share.available&&<Button label="Share Proof" icon="share-outline" onPress={()=>setSharing(true)}/>}<Button label="Recording history and details" variant="secondary" onPress={()=>setDetails(true)}/><SignalText kind="caption" muted>{proof.proofId}</SignalText></ScrollView>{sharing&&<SharingScreen asSheet onClose={()=>setSharing(false)}/>}</>;
}
