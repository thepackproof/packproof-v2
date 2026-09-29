// @ts-nocheck
// Simulator-only entry point. Uses unchanged production screen components with synthetic records.
// The App Store archive never imports this file or includes its navigation hooks.
import React, { useEffect, useMemo, useState, useRef } from 'react';
import * as FileSystem from 'expo-file-system';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';
import { PackProofContext } from '../src/app/PackProofProvider';
import { MyProofsScreen } from '../src/screens/MyProofsScreen';
import { ProofDetailScreen } from '../src/screens/ProofDetailScreen';
import { ManualCreateScreen } from '../src/screens/ManualCreateScreen';
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
  [proofId,'ORDER-1028',transaction.itemTitle,'FINALIZED','12:40'],
  ['proof_sample_1026','ORDER-1026','Limited edition art print','FINALIZED','10:30'],
].map(([id,reference,title,status,time]) => ({ proofId:id, transactionId:`txn-${id}`, role:'SELLER', status, createdAt:at('09:10'), updatedAt:at(time), finalizedAt:status==='FINALIZED'?at('09:15'):null, transaction:{externalReference:reference,itemTitle:title,transactionDate:day,carrier:'USPS',trackingNumber:status==='FINALIZED'?shipping.trackingNumber:null,service:'Ground Advantage',provider:null} }));
const noop = () => {};
const resolved = async () => {};
const client = {
  assertCaptureAccount:noop,
  intakeRequest:async (path:string) => path==='/capabilities'?{enabled:false,submissionEnabled:false,handoffEnabled:false}:path==='/devices'?{devices:[]}:path==='/orders'?{orders:[]}:{submissions:[]},
  proofNotificationMute:async()=>({muted:false}),
  authorizedDownloadHeaders:()=>({}),
};
function Screens(){
  const theme=useTheme();
  const [scene,setScene]=useState('library');
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
      const request=JSON.parse(raw);
      setScene(request.scene);
      await theme.setPreference(request.theme==='dark'?'dark':'light');
      setTimeout(()=>{if(active)void FileSystem.writeAsStringAsync(FileSystem.documentDirectory+'store-scene-ready.txt',request.scene+':'+request.theme);},1500);
    })().catch(()=>{});},300);
    return()=>{active=false;clearInterval(timer);};
  },[]);
  const value=useMemo(()=>({ hydrated:true,busy:false,offline:false,error:null,errorDetail:null,route:{name:scene==='library'?'home':scene==='create'?'create':'proof'},session:{userId,displayName:'Alex Morgan',username:'alexmorgan',token:'simulator-fixture'},proof,transactionDetail:transaction,proofCollection:collection,pendingInvites:[],savedRecordings:[],uploadProgressByProof:{},captureStatus:'idle',localCapture:null,uploadPercent:null,role:'SELLER',proofsLibrary:library,apiBaseUrl:'https://example.invalid',client,createForm:form,intakeReview:null,batchPacking:false,
  ensureAuth:resolved,syncWorkspace:resolved,run:async(fn:()=>Promise<void>)=>fn(),readProofsScrollOffset:()=>0,setProofsScrollOffset:noop,setProofsView:(view:string)=>setLibrary(v=>({...v,view})),setProofsQuery:(query:string)=>setLibrary(v=>({...v,query})),setProofsRoleFilter:noop,setProofsCarrierFilter:noop,
  readProofRecordView:()=>({...initialProofRecordView(),tab:scene==='tracking'?'Tracking':'Timeline'}),saveProofRecordView:noop,refreshProof:async()=>proof,go:noop,goBack:()=>setScene('library'),openProof:async()=>setScene('activity'),openReceipt:noop,setCreateForm:setForm,setSelectedEvent:noop,shareProofLink:resolved,createManualProof:resolved,connections:[],connectedAccounts:[],connectedProviders:[],technicalOpen:false,setTechnicalOpen:noop,
  }),[scene,form,library]);
  if(!theme.hydrated)return null;
  return <PackProofContext.Provider value={value}><StatusBar style={theme.scheme==='dark'?'light':'dark'}/>{scene==='library'?<MyProofsScreen/>:scene==='create'?<ManualCreateScreen/>:<ProofDetailScreen key={scene}/>}</PackProofContext.Provider>;
}
export default function StoreScreenshots(){return <SafeAreaProvider><ThemeProvider><Screens/></ThemeProvider></SafeAreaProvider>;}
