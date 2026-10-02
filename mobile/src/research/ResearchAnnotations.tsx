import {useEffect,useRef,useState} from 'react';
import {Text,TextInput,View} from 'react-native';
import type {AnalysisEnvelope,SourceRef} from '../../../packages/evidence-contracts/contracts.mjs';
import {usePackProof} from '../app/PackProofProvider';
import {useTheme} from '../theme/ThemeProvider';
import {Button} from '../ui/Button';
import {newIdempotencyKey} from '../v2-api';
interface Annotation {annotationId:string;proofId:string;analysisId:string;actorId:string;statement:string;supersedesId:string|null;sourceRefs:SourceRef[];createdAt:string}
export function ResearchAnnotations({envelope,onSource}:{envelope:AnalysisEnvelope;onSource:(ref:SourceRef)=>void}){
 const app=usePackProof(),{colors}=useTheme(),alive=useRef(true);
 const [notes,setNotes]=useState<Annotation[]>([]),[statement,setStatement]=useState(''),[sourceId,setSourceId]=useState(envelope.sourceRefs[0]?.sourceId??''),[supersedesId,setSupersedesId]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const refresh=async()=>{const result=await app.client.researchRequest<{annotations:Array<{annotation:Annotation}>}>(envelope.proofId,'/annotations');const rows=result.annotations.map(r=>r.annotation).filter(n=>n.proofId===envelope.proofId&&n.analysisId===envelope.analysisId);if(alive.current)setNotes(rows);};
 useEffect(()=>{alive.current=true;void refresh().catch(()=>{if(alive.current)setError('Reviewer statements unavailable.');});return()=>{alive.current=false;};},[envelope.analysisId]);
 async function save(){if(busy||!sourceId||!statement.trim())return;setBusy(true);setError('');try{await app.ensureAuth();await app.client.researchRequest(envelope.proofId,'/annotations','POST',{analysisId:envelope.analysisId,sourceId,text:statement.trim(),...(supersedesId?{supersedesId}:{})},newIdempotencyKey());if(alive.current){setStatement('');setSupersedesId(null);}await refresh();}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Statement could not be recorded');}finally{if(alive.current)setBusy(false);}}
 return <View style={{gap:8,paddingVertical:8}}><Text style={{color:colors.textPrimary}}>Reviewer statements and corrections</Text><Text style={{color:colors.textSecondary}}>Your statement is attributed to your account and linked to the selected source. Machine observations and the sealed Proof remain preserved.</Text>
 {envelope.sourceRefs.map(ref=><Button key={ref.sourceId} label={`${sourceId===ref.sourceId?'Selected · ':''}${ref.sourceId}`} variant="tertiary" onPress={()=>setSourceId(ref.sourceId)}/>)}
 {supersedesId?<Text style={{color:colors.textSecondary}}>Amending your prior statement {supersedesId}. Its original version remains in the record.</Text>:null}
 <TextInput accessibilityLabel="Attributed reviewer statement or correction" value={statement} onChangeText={setStatement} maxLength={2000} multiline style={{color:colors.textPrimary,minHeight:70,borderWidth:1,borderColor:colors.border,padding:10}}/>
 <Button label="Record source-linked statement" disabled={busy||!sourceId||!statement.trim()} onPress={()=>void save()}/>
 {notes.map(note=><View key={note.annotationId} style={{gap:5}}><Text selectable style={{color:colors.textPrimary}}>{note.statement}</Text><Text style={{color:colors.textSecondary}}>{note.actorId} · {note.createdAt}{note.supersedesId?' · amended statement':''}{notes.some(n=>n.supersedesId===note.annotationId)?' · later amended':''}</Text>{note.sourceRefs.map(ref=><Button key={ref.sourceId} label="Open statement source" variant="tertiary" onPress={()=>onSource(ref)}/>)}{note.actorId===app.session?.userId?<Button label="Amend my statement" variant="tertiary" onPress={()=>{setSupersedesId(note.annotationId);setSourceId(note.sourceRefs[0]?.sourceId??'');setStatement(note.statement);}}/>:null}</View>)}
 {error?<Text accessibilityRole="alert" style={{color:colors.error}}>{error}</Text>:null}
 </View>;
}
