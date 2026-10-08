// @ts-nocheck
// Simulator-only design-review entry point. Uses production screens with synthetic records.
// The App Store archive never imports this file or includes its navigation hooks.
import React, { useEffect, useMemo, useState, useRef } from 'react';
import * as FileSystem from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { PackProofContext } from '../src/app/PackProofProvider';
import { MyProofsScreen } from '../src/screens/MyProofsScreen';
import { ProofDetailScreen } from '../src/screens/ProofDetailScreen';
import { ManualCreateScreen } from '../src/screens/ManualCreateScreen';
import { WorkspaceHomeScreen } from '../src/screens/WorkspaceHomeScreen';
import { WorkspaceOrdersScreen } from '../src/screens/WorkspaceOrdersScreen';
import { AccountScreen } from '../src/screens/AccountScreen';
import { initialProofRecordView } from '../src/copy/proof-record';
import { EMPTY_FORM } from '../src/copy/forms';

const day = '2026-09-29';
const at = (time: string) => `${day}T${time}:00.000Z`;
const userId = 'sample-seller';
const proofId = 'proof_sample_collectibles_1028';
const transactionId = 'txn_sample_1028';
const shipping = { carrier: 'USPS', service: 'Ground Advantage', trackingNumber: '9400 1000 0000 0000 0000 00', shipmentDate: day };
const transaction = { transactionId, externalReference: 'ORDER-1028', transactionDate: day, itemTitle: 'Vintage trading card collection', itemDescription: 'Three cards in protective sleeves and a rigid mailer.', quantity: 1, transactionValue: 125, currency: 'USD', createdBy: userId, sellerUserId: userId, buyerUserId: null, createdAt: at('09:10'), updatedAt: at('09:15'), metadata: {}, shipping, proofId, proofStatus: 'FINALIZED' };
const events = [
  ['accepted', 'ACCEPTED', '10:20', 'Columbus, OH', 'Shipment accepted at origin facility'],
  ['transit', 'IN_TRANSIT', '12:40', 'Columbus, OH', 'Departed regional facility'],
].map(([id,eventType,time,location,description]) => ({ id, proofId, transactionId, eventType, occurredAt: at(time), observedAt: at(time), source: 'SHIPPO', provider: 'USPS', carrier: 'USPS', location, eventData: { description }, sha256: 'a'.repeat(64), sourceEventId: `sample-${id}` }));
const chronology = [
  ['created','PROOF_CREATED','09:10','Proof created','Order details attached to this Proof.','PROOF','PackProof'],
  ['capture','EVIDENCE_COMMITTED','09:14','Packing recording saved','Continuous packing recording uploaded.','PROOF','PackProof'],
  ['finalized','PROOF_FINALIZED','09:15','Proof finalized','The shipment record was finalized.','PROOF','PackProof'],
  ['accepted','SHIPMENT_ACCEPTED','10:20','Shipment accepted','Columbus, OH','SHIPMENT','USPS'],
  ['transit','SHIPMENT_IN_TRANSIT','12:40','In transit','Departed regional facility.','SHIPMENT','USPS'],
].map(([id,eventType,time,title,description,category,source]) => ({ id, eventType, occurredAt: at(time), title, description, category, source, relatedEntityId: null }));
const proof = { proofId, transactionId, status: 'FINALIZED', participationPolicy: 'COUNTERPARTY_OPTIONAL', version: 3, createdAt: at('09:10'), updatedAt: at('12:40'), finalizedAt: at('09:15'), manifestId: 'manifest-sample', transaction, participants: [{ participantId: 'participant-sample', userId, role: 'SELLER', status: 'JOINED', joinedAt: at('09:10') }], evidence: [], events: [], attestations: [], chronology, shipmentObservations: { shippingId: 'shipping-sample', identity: shipping, events, latest: events[1] }, shipmentSync: { available: true, connectionId: 'connection-sample', adapterKey: 'shippo', provider: 'SHIPPO', status: 'ACTIVE' } };
const collection = [
  ['proof_sample_1030','ORDER-1030','Retro handheld console','READY_FOR_EVIDENCE','13:00'],
  ['proof_sample_1029','ORDER-1029','Illustrated field guide','READY_FOR_EVIDENCE','12:55'],
  ['proof_sample_1027','ORDER-1027','Studio ceramic mug','READY_FOR_EVIDENCE','12:45'],
  [proofId,'ORDER-1028',transaction.itemTitle,'FINALIZED','12:40'],
  ['proof_sample_1026','ORDER-1026','Limited edition art print','FINALIZED','10:30'],
].map(([id,reference,title,status,time]) => ({ proofId:id, transactionId:`txn-${id}`, role:'SELLER', status, createdAt:at('09:10'), updatedAt:at(time), finalizedAt:status==='FINALIZED'?at('09:15'):null, transaction:{externalReference:reference,itemTitle:title,transactionDate:day,carrier:'USPS',trackingNumber:status==='FINALIZED'?shipping.trackingNumber:null,service:'Ground Advantage',provider:null} }));
const noop = () => {};
const resolved = async () => {};
const apiBaseUrl = 'https://simulator-review.example.invalid';
const providers = [
  ['ebay', 'eBay', false, true], ['etsy', 'Etsy', false, true],
  ['shopify', 'Shopify', true, true], ['google', 'Google', false, false], ['facebook', 'Meta', false, false],
].map(([provider, providerDisplay, enabled, commerce]) => ({
  provider, providerDisplay, enabled, multipleAccounts: true, requiresShop: provider === 'shopify',
  capabilities: { identity: true, transactions: commerce, fulfillment: commerce, shipping: false, webhooks: false },
  limitations: ['Illustrative provider availability for this local design review.'],
}));
const client = {
  apiBaseUrl,
  assertCaptureAccount:noop,
  intakeRequest:async (path:string, method = 'GET') => {
    if (method !== 'GET') throw new Error('Sample-data review does not submit or change records.');
    if (path === '/capabilities') return { enabled: false, submissionEnabled: false, handoffEnabled: false, emailEnabled: false, mailDomainConfigured: false };
    if (path === '/devices') return { devices: [] };
    if (path === '/orders') return { orders: [] };
    if (path === '/submissions') return { submissions: [] };
    if (path === '/mail') return { aliases: [] };
    throw new Error(`No sample response for ${path}`);
  },
  listFulfillmentQueue:async()=>({items:[]}),
  getDeveloperAccess:async()=>({allowed:false}),
  proofNotificationMute:async()=>({muted:false}),
  authorizedDownloadHeaders:()=>({}),
};
class SceneBoundary extends React.Component<{children:React.ReactNode}, {error:string|null}> {
  state = { error: null };
  static getDerivedStateFromError(error:Error) { return { error: error.message }; }
  componentDidCatch(error:Error) {
    void FileSystem.writeAsStringAsync(FileSystem.documentDirectory+'store-scene-error.txt', error.stack || error.message);
  }
  render() { return this.state.error ? <Text accessibilityRole="alert">Design review could not render: {this.state.error}</Text> : this.props.children; }
}
function Screens(){
  const theme=useTheme();
  const insets=useSafeAreaInsets();
  const [scene,setScene]=useState('library');
  const [request,setRequest]=useState<{scene:string;theme:'light'|'dark'}|null>(null);
  const [form,setForm]=useState({...EMPTY_FORM,itemTitle:'Vintage trading card collection',itemDescription:'Three cards in protective sleeves and a rigid mailer.',externalReference:'ORDER-1031',quantity:'1',currency:'USD',transactionValue:'125.00'});
  const [library,setLibrary]=useState({view:'all',query:'',role:'all',carrier:null,sort:'updated'});
  const requestRef=useRef('');
  useEffect(()=>{
    let active=true;
    const timer=setInterval(()=>{void (async()=>{
      const path=FileSystem.documentDirectory+'store-scene.json';
      if(!(await FileSystem.getInfoAsync(path)).exists)return;
      const raw=await FileSystem.readAsStringAsync(path);
      if(!active||raw===requestRef.current)return;
      requestRef.current=raw;
      const next=JSON.parse(raw);
      const target={scene:next.scene,theme:next.theme==='dark'?'dark':'light'};
      setScene(target.scene);
      setRequest(target);
      await theme.setPreference(target.theme);
    })().catch(()=>{});},300);
    return()=>{active=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{
    if(!request || !theme.hydrated || request.scene!==scene || request.theme!==theme.scheme)return;
    // Allow layout, async fixture reads, and native animations to settle before capture.
    const timer=setTimeout(()=>{void (async()=>{
      if((await FileSystem.getInfoAsync(FileSystem.documentDirectory+'store-scene-error.txt')).exists)return;
      await FileSystem.writeAsStringAsync(FileSystem.documentDirectory+'store-scene-ready.txt',request.scene+':'+request.theme);
    })();},2000);
    return()=>clearTimeout(timer);
  },[request,scene,theme.hydrated,theme.scheme]);
  const value=useMemo(()=>({ hydrated:true,busy:false,offline:false,error:null,errorDetail:null,route:{name:scene==='library'?'proofs':['home','orders','station','create'].includes(scene)?scene:scene==='integrations'?'account':'proof'},session:{userId,displayName:'Alex Morgan',username:'alexmorgan',email:'alex@example.invalid',token:'simulator-fixture',apiBaseUrl},proof,transactionDetail:transaction,proofCollection:collection,pendingInvites:[],savedRecordings:[],uploadProgressByProof:{},captureStatus:'idle',localCapture:null,uploadPercent:null,role:'SELLER',proofsLibrary:library,apiBaseUrl,client,createForm:form,intakeReview:null,batchPacking:false,
  ensureAuth:resolved,syncWorkspace:resolved,run:async(fn:()=>Promise<void>)=>fn(),readProofsScrollOffset:()=>0,setProofsScrollOffset:noop,setProofsView:(view:string)=>setLibrary(v=>({...v,view})),setProofsQuery:(query:string)=>setLibrary(v=>({...v,query})),setProofsRoleFilter:noop,setProofsCarrierFilter:noop,
  readProofRecordView:()=>({...initialProofRecordView(),tab:scene==='tracking'?'Tracking':'Timeline'}),saveProofRecordView:noop,refreshProof:async()=>proof,go:noop,goBack:()=>setScene('library'),openProof:async()=>setScene('activity'),openReceipt:noop,setCreateForm:setForm,setSelectedEvent:noop,shareProofLink:resolved,createManualProof:resolved,connections:[],connectedAccounts:[],connectedProviders:providers,technicalOpen:false,setTechnicalOpen:noop,
  readOrdersView:()=>({query:'',offsetY:0}),saveOrdersView:noop,openOrder:resolved,setError:noop,loadConnections:resolved,loadConnectedAccounts:resolved,displayNameInput:'Alex Morgan',usernameInput:'alexmorgan',connectConnectedAccount:resolved,
  }),[scene,form,library]);
  if(!theme.hydrated)return null;
  return <PackProofContext.Provider value={value}><View style={{flex:1,backgroundColor:theme.colors.background}}><StatusBar style={theme.scheme==='dark'?'light':'dark'}/><View style={styles.scene}><SceneBoundary key={`${scene}:${theme.scheme}`}>
    {scene==='home'?<WorkspaceHomeScreen/>:scene==='orders'?<WorkspaceOrdersScreen/>:scene==='station'?<WorkspaceOrdersScreen station/>:scene==='integrations'?<AccountScreen initialSection="channels"/>:scene==='library'?<MyProofsScreen/>:scene==='create'?<ManualCreateScreen/>:<ProofDetailScreen key={scene}/>}
    </SceneBoundary></View><View pointerEvents="none" style={[styles.sampleFooter,{paddingBottom:Math.max(insets.bottom,8)}]}><View style={[styles.sampleLabel,{backgroundColor:theme.colors.surfaceElevated,borderColor:theme.colors.border}]}><Text style={[styles.sampleText,{color:theme.colors.textSecondary}]}>DESIGN REVIEW · SAMPLE DATA</Text></View></View></View></PackProofContext.Provider>;
}
export default function StoreScreenshots(){return <SafeAreaProvider><ThemeProvider><Screens/></ThemeProvider></SafeAreaProvider>;}
const styles=StyleSheet.create({scene:{flex:1,minHeight:0},sampleFooter:{alignItems:'center',paddingTop:5,paddingHorizontal:12},sampleLabel:{paddingVertical:5,paddingHorizontal:10,borderWidth:1,borderRadius:6},sampleText:{fontFamily:'Inter-SemiBold',fontSize:9,lineHeight:13,letterSpacing:.8}});
