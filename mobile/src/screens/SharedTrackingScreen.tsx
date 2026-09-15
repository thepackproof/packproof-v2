import { useState } from 'react';
import { Text,View } from 'react-native';
import { usePackProof } from '../app/PackProofProvider';
import { useTheme } from '../theme/ThemeProvider';
import { typography } from '../theme/tokens';
import { AppScreen } from '../ui/AppScreen';
import { AppHeader } from '../ui/AppHeader';
import { Button } from '../ui/Button';
import { FormField } from '../ui/FormField';
import { proofReference } from '../copy/evidence-record';
export function looksLikeSharedTracking(text:string){
  const value=text.trim();
  if(/^(1Z[A-Z0-9]{16}|9\d{19,21}|[A-Z]{2}\d{9}US)$/i.test(value.replace(/[\s-]/g,'')))return true;
  try{const url=new URL(value);return /^https?:$/.test(url.protocol)&&['usps.com','ups.com','fedex.com','dhl.com','dhl.de'].some(d=>url.hostname===d||url.hostname.endsWith('.'+d));}catch{return false;}
}
export function SharedTrackingScreen({text,onConsumed,onOrder}:{text:string;onConsumed:()=>void;onOrder:()=>void}){
  const app=usePackProof(),{colors}=useTheme();const [value,setValue]=useState(text),[carrier,setCarrier]=useState(''),[selected,setSelected]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  return <AppScreen><AppHeader title="Add tracking to a Proof" onBack={()=>{onConsumed();app.goBack();}}/><FormField label="Tracking number or carrier link" value={value} onChangeText={setValue}/>
    <View style={{flexDirection:'row',gap:6,flexWrap:'wrap'}}>{[['usps','USPS'],['ups','UPS'],['fedex','FedEx'],['dhl_express','DHL']].map(([key,label])=><Button key={key} label={`${carrier===key?'✓ ':''}${label}`} variant="tertiary" onPress={()=>setCarrier(key)}/>)}</View>
    <Text style={[typography.body,{color:colors.textPrimary}]}>Which shipment is this for?</Text>
    {app.proofCollection.filter(p=>p.role==='SELLER'&&p.accessKind!=='INVITATION').map(p=><Button key={p.proofId} label={`${selected===p.proofId?'✓ ':''}${p.transaction.itemTitle||'Shipment'} · ${proofReference(p.proofId,p.transaction.externalReference)}`} variant="secondary" onPress={()=>setSelected(p.proofId)}/>)}
    {!app.proofCollection.length?<Button label="Load my Proofs" onPress={()=>void app.run(app.syncWorkspace)}/>:null}
    <Text style={[typography.finePrint,{color:colors.textSecondary}]}>This adds a separate tracking association. It does not rewrite the packing record.</Text>
    <Button label="Save and connect tracking" disabled={!selected||!value.trim()} loading={busy} onPress={()=>{if(!selected)return;setBusy(true);void app.ensureAuth().then(()=>app.client.attachTracking(selected,value,carrier)).then(async()=>{onConsumed();await app.openProof(selected);}).catch(e=>setError(e instanceof Error?e.message:'Tracking could not be saved.')).finally(()=>setBusy(false));}}/>
    {error?<Text accessibilityRole="alert" style={[typography.secondary,{color:colors.error}]}>{error}</Text>:null}
    <Button label="Use this as order information instead" variant="tertiary" onPress={onOrder}/>
  </AppScreen>;
}
