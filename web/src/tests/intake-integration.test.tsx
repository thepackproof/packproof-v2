import { Blob as NodeBlob } from 'node:buffer';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import type { IntakeOrder, IntakeSnapshot } from '../intake-types';
import { intakePreferenceKey } from '../intake-types';
import { ReadyIntakeOrders } from '../components/ReadyIntakeOrders';
import { IntakeSettingsPanel } from '../components/IntakeSettingsPanel';
import { SelectedOrderHandoff } from '../components/SelectedOrderHandoff';
import { PackingStationScreen } from '../screens/PackingStationScreen';
import { canonicalProof } from './fixtures';
import { recoverStationCapture } from '../capture-queue';

vi.mock('../capture-queue',()=>({recoverStationCapture:vi.fn(async()=>null),saveStationCapture:vi.fn(async()=>{}),updateStationCaptureScans:vi.fn(async()=>{}),resumeStationRecording:vi.fn(async()=>({completion:'FINALIZED'})),stationCaptureKey:(user:string)=>`${user}:station`}));
vi.mock('../components/RelayStationPanel',()=>({RelayStationPanel:()=>null}));
const owner='user_seller';
const caps={enabled:true,handoffEnabled:true,emailEnabled:false,browserEnabled:false,shippoEnabled:false,mailDomainConfigured:false};
const snapshot:IntakeSnapshot={id:'snapshot/one',version:1,digest:'a'.repeat(64),proofId:canonicalProof.proofId,transactionId:canonicalProof.transactionId,items:[{title:'Vintage camera',quantity:2,variant:'Black body'},{title:'Lens cap',quantity:1}],store:'Camera store',orderReference:'ORD-48392',sourceKind:'API_OBSERVED'};
const ready:IntakeOrder={observationId:'observation-one',readiness:'READY',reasons:[],transactionId:snapshot.transactionId,proofId:snapshot.proofId,snapshot};
class Recorder {
  static failNext=false;
  static starts=0;
  static isTypeSupported(){return true;}
  state='inactive';mimeType='video/webm';
  ondataavailable:((event:{data:Blob})=>void)|null=null;
  onstop:(()=>void)|null=null;
  constructor(){if(Recorder.failNext){Recorder.failNext=false;throw new Error('Recorder startup failed');}}
  start(){this.state='recording';Recorder.starts++;}
  stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['original packing bytes'],{type:this.mimeType})});queueMicrotask(()=>this.onstop?.());}
}
function client(handler:(path:string,method:string,body:unknown)=>unknown|Promise<unknown>) {
  return { recoveryScope:'https://intake.test',
    intakeRequest:vi.fn(async(path:string,method='GET',body?:unknown)=>handler(path,method,body)),
    getProof:vi.fn(async()=>({...canonicalProof,status:'READY_FOR_EVIDENCE',evidence:[],attestations:[],participationPolicy:'COUNTERPARTY_OPTIONAL'})),
    getCapabilities:vi.fn(async()=>({schemaVersion:1,capture:{protocolVersions:[1],maxBytes:1000000,maxDurationSeconds:120,maxActiveUploads:2},preservation:{receiptVersions:[1],durableReceiptsRequired:true},shippingReview:{requiredForObservedConflicts:true,noLabelAllowed:true},correctionPolicy:{importedFactsReadOnly:true,captureBindingLocksManualDetails:true},sellerAttestation:{contextBindingVersion:1}})),
    createCaptureSession:vi.fn(async()=>({id:'legacy-capture',state:'ISSUED'})),
    featureRequest:vi.fn(async()=>({cancelled:true})),
    getCaptureShippingReview:vi.fn(async()=>({currentTrackingNumber:null,reviewRequired:false,observations:[]})),
  };
}
beforeEach(()=>{
  localStorage.clear();vi.clearAllMocks();vi.mocked(recoverStationCapture).mockResolvedValue(null);
  Recorder.failNext=false;Recorder.starts=0;
  vi.stubGlobal('Blob',NodeBlob);vi.stubGlobal('MediaRecorder',Recorder);
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:()=> 'blob:intake-recording'});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:()=>{}});
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:vi.fn(async()=>({getTracks:()=>[{stop:vi.fn()}]}))}});
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue(undefined);
  Object.defineProperty(HTMLVideoElement.prototype,'videoWidth',{configurable:true,get:()=>640});
});
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

it('records the displayed multi-item snapshot in one deliberate action and retains it after consuming navigation intent',async()=>{
  const api=client(path=>path==='/capabilities'?caps:path==='/orders'?{orders:[ready]}:path==='/orders/snapshot%2Fone/capture'?{session:{id:'accepted-capture',state:'ISSUED'}}:Promise.reject(new Error(`Unexpected ${path}`)));
  const consumed=vi.fn();
  function Flow(){const [recording,setRecording]=useState(false),[accepted,setAccepted]=useState<IntakeSnapshot|null>(null);
    return recording?<PackingStationScreen api={api as unknown as PackProofApi} userId={owner} initialProofId={snapshot.proofId} acceptedIntakeSnapshot={accepted} onIntakeIntentConsumed={()=>{consumed();setAccepted(null);}} queue={[]} error={null} onAuthExpired={()=>{}}/>:<ReadyIntakeOrders api={api as unknown as PackProofApi} userId={owner} onRecord={value=>{setAccepted(value);setRecording(true);}}/>;
  }
  render(<Flow/>);
  expect(await screen.findByText('Vintage camera · Black body · Quantity 2')).toBeInTheDocument();
  expect(screen.getByText('Lens cap · Quantity 1')).toBeInTheDocument();
  expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button',{name:'Record packing'}));
  expect(await screen.findByRole('button',{name:'Finish recording'})).toBeInTheDocument();
  expect(consumed).toHaveBeenCalledTimes(1);expect(Recorder.starts).toBe(1);
  expect(api.intakeRequest).toHaveBeenCalledWith('/orders/snapshot%2Fone/capture','POST',{client:'WEB_CAMERA',idempotencyKey:expect.any(String)});
  expect(api.createCaptureSession).not.toHaveBeenCalled();
});

it('resolves incomplete source facts and refreshes the same ready-order surface without selecting another order',async()=>{
  let resolved=false;
  const missing={...ready,readiness:'NEEDS_INFORMATION',snapshot:null,reasons:['ITEM_DESCRIPTION_AND_QUANTITY_REQUIRED']};
  const api=client((path,method,body)=>{
    if(path==='/capabilities')return caps;
    if(path==='/orders')return{orders:[resolved?ready:missing]};
    if(path==='/observations/observation-one')return{items:[{title:'Vintage camera',quantity:null,variant:'Black body'}],physicalFulfillment:null,paid:null,fulfillmentScope:'UNKNOWN',orderReference:snapshot.orderReference};
    if(path==='/observations/observation-one/resolve'&&method==='POST'){
      expect(body).toMatchObject({items:[{title:'Vintage camera',quantity:2,variant:'Black body'}],physicalFulfillment:true,paid:true,fulfillmentScope:'FULL_ORDER',reason:'Checked the original sale',receiptId:expect.any(String)});
      resolved=true;return ready;
    }
    throw new Error(`Unexpected ${path}`);
  });
  const record=vi.fn();render(<ReadyIntakeOrders api={api as unknown as PackProofApi} userId={owner} onRecord={record}/>);
  await userEvent.click(await screen.findByRole('button',{name:'Resolve'}));
  await userEvent.type(await screen.findByLabelText('Quantity'),'2');
  await userEvent.selectOptions(screen.getByLabelText('Payment'),'true');
  await userEvent.selectOptions(screen.getByLabelText('Fulfillment'),'true');
  await userEvent.selectOptions(screen.getByLabelText('What this package contains'),'FULL_ORDER');
  await userEvent.type(screen.getByLabelText('Reason for this correction'),'Checked the original sale');
  await userEvent.click(screen.getByRole('button',{name:'Save order context'}));
  await userEvent.click(await screen.findByRole('button',{name:'Record packing'}));
  expect(record).toHaveBeenCalledWith(snapshot);expect(screen.queryByRole('region',{name:'Resolve order'})).not.toBeInTheDocument();
});

it('reads the single devices envelope, approves the selected phone and keeps its preference scoped to the signed-in account',async()=>{
  let approved=false;
  const api=client((path,method,body)=>{
    if(path==='/capabilities')return caps;
    if(path==='/devices')return{devices:[{id:'phone-one',name:'Galaxy A16',state:approved?'APPROVED':'AWAITING_APPROVAL'}]};
    if(path==='/mail')return{aliases:[]};
    if(path==='/devices/phone-one/approve'&&method==='POST'){expect(body).toEqual({pairingCode:'A1B2C3D4E5F6'});approved=true;return{device:{id:'phone-one',state:'APPROVED'}};}
    throw new Error(`Unexpected ${path}`);
  });
  render(<IntakeSettingsPanel api={api as unknown as PackProofApi} userId={owner} connections={[]}/>);
  await screen.findByRole('option',{name:'Galaxy A16'});
  await userEvent.selectOptions(screen.getByLabelText('Recording device'),'phone-one');
  await userEvent.type(screen.getByLabelText('Pairing code shown on your phone'),'A1B2C3D4E5F6');
  await userEvent.click(screen.getByRole('button',{name:'Approve phone'}));
  await waitFor(()=>expect(approved).toBe(true));
  expect(JSON.parse(localStorage.getItem(intakePreferenceKey(api.recoveryScope,owner))!)).toMatchObject({deviceId:'phone-one'});
  expect(localStorage.getItem(intakePreferenceKey(api.recoveryScope,'other-owner'))).toBeNull();
  expect(screen.getByLabelText('Pairing code shown on your phone')).toHaveValue('');
});

it('sends the explicitly selected transaction and retries a lost handoff response with the same snapshot and key',async()=>{
  let sends=0;
  const api=client((path,method,body)=>{
    if(path==='/capabilities')return caps;
    if(path==='/orders/prepare'){expect(method).toBe('POST');expect(body).toEqual({transactionId:snapshot.transactionId});return ready;}
    if(path==='/handoffs'){sends++;if(sends===1)throw new Error('The response was lost. Try again.');return{handoff:{id:'handoff-one',state:'PENDING'}};}
    throw new Error(`Unexpected ${path}`);
  });
  localStorage.setItem(intakePreferenceKey(api.recoveryScope,owner),JSON.stringify({deviceId:'phone-one'}));
  render(<SelectedOrderHandoff api={api as unknown as PackProofApi} userId={owner} transactionId={snapshot.transactionId}/>);
  await userEvent.click(await screen.findByRole('button',{name:'Record on phone'}));
  await screen.findByText('The response was lost. Try again.');
  await userEvent.click(screen.getByRole('button',{name:'Record on phone'}));
  await screen.findByText('Order ready; open PackProof on your recording phone.');
  const calls=api.intakeRequest.mock.calls.filter(call=>call[0]==='/handoffs');
  expect(calls).toHaveLength(2);expect(calls[0]).toEqual(calls[1]);
  expect(calls[0][2]).toMatchObject({snapshotId:snapshot.id,targetDeviceId:'phone-one',idempotencyKey:expect.any(String)});
  expect(api.createCaptureSession).not.toHaveBeenCalled();
});

it.each([true,false])('retries camera startup without losing accepted order context when cancellation confirmation is %s',async(cancellationConfirmed)=>{
  const captures:Array<{idempotencyKey:string;client:string}>=[];
  const api=client((path,_method,body)=>{
    if(path==='/orders/snapshot%2Fone/capture'){
      captures.push(body as {idempotencyKey:string;client:string});
      if(!cancellationConfirmed&&captures.length===2)return{session:{id:'unused-capture',state:'CANCELLED'}};
      return{session:{id:captures.length===1?'unused-capture':'retry-capture',state:'ISSUED'}};
    }
    throw new Error(`Unexpected ${path}`);
  });
  if(!cancellationConfirmed)api.featureRequest.mockRejectedValueOnce(new Error('Cancellation response lost'));
  Recorder.failNext=true;
  function Flow(){const [accepted,setAccepted]=useState<IntakeSnapshot|null>(snapshot);return<PackingStationScreen api={api as unknown as PackProofApi} userId={owner} initialProofId={snapshot.proofId} acceptedIntakeSnapshot={accepted} onIntakeIntentConsumed={()=>setAccepted(null)} queue={[]} error={null} onAuthExpired={()=>{}}/>;}
  render(<Flow/>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Recorder startup failed');
  await waitFor(()=>expect(api.featureRequest).toHaveBeenCalledWith(snapshot.proofId,'capture-sessions/unused-capture/cancel','POST',{}));
  await userEvent.click(screen.getByRole('button',{name:'Try camera again'}));
  const record=screen.getByRole('button',{name:'Record packing'});await waitFor(()=>expect(record).toBeEnabled());fireEvent.click(record);
  await screen.findByRole('button',{name:'Finish recording'});
  expect(Recorder.starts).toBe(1);expect(api.createCaptureSession).not.toHaveBeenCalled();
  if(cancellationConfirmed){expect(captures).toHaveLength(2);expect(captures[0].idempotencyKey).not.toBe(captures[1].idempotencyKey);}
  else{expect(captures).toHaveLength(3);expect(captures[0].idempotencyKey).toBe(captures[1].idempotencyKey);expect(captures[1].idempotencyKey).not.toBe(captures[2].idempotencyKey);}
});

it.each(['ready-list','selected-order'])('resends expired %s prompts once and shows revoked-device responses honestly',async(surface)=>{
  const states=['EXPIRED','PENDING','REVOKED'];let sends=0;
  const api=client(path=>{
    if(path==='/capabilities')return caps;
    if(path==='/orders')return{orders:[ready]};
    if(path==='/orders/prepare')return ready;
    if(path==='/handoffs')return{handoff:{id:'handoff-one',state:states[sends++]}};
    throw new Error(`Unexpected ${path}`);
  });
  localStorage.setItem(intakePreferenceKey(api.recoveryScope,owner),JSON.stringify({deviceId:'phone-one'}));
  render(surface==='ready-list'?<ReadyIntakeOrders api={api as unknown as PackProofApi} userId={owner} onRecord={()=>{}}/>:<SelectedOrderHandoff api={api as unknown as PackProofApi} userId={owner} transactionId={snapshot.transactionId}/>);
  await userEvent.click(await screen.findByRole('button',{name:'Record on phone'}));
  await screen.findByText('Order ready; open PackProof on your recording phone.');
  const sent=api.intakeRequest.mock.calls.filter(call=>call[0]==='/handoffs').map(call=>call[2] as {snapshotId:string;targetDeviceId:string;idempotencyKey:string});
  expect(sent).toHaveLength(2);expect(sent[0].idempotencyKey).not.toBe(sent[1].idempotencyKey);
  expect(sent[1]).toMatchObject({snapshotId:snapshot.id,targetDeviceId:'phone-one'});
  await userEvent.click(screen.getByRole('button',{name:'Record on phone'}));
  await screen.findByText('This recording phone has been disconnected. Pair it again in Settings.');
  expect(screen.queryByText('Order ready; open PackProof on your recording phone.')).not.toBeInTheDocument();
  expect(sends).toBe(3);
});

it.each(['ready-list','selected-order'])('bounds repeated expiry for %s to one replacement request',async(surface)=>{
  let sends=0;
  const api=client(path=>{
    if(path==='/capabilities')return caps;
    if(path==='/orders')return{orders:[ready]};
    if(path==='/orders/prepare')return ready;
    if(path==='/handoffs'){sends++;return{handoff:{state:'EXPIRED'}};}
    throw new Error(`Unexpected ${path}`);
  });
  localStorage.setItem(intakePreferenceKey(api.recoveryScope,owner),JSON.stringify({deviceId:'phone-one'}));
  render(surface==='ready-list'?<ReadyIntakeOrders api={api as unknown as PackProofApi} userId={owner} onRecord={()=>{}}/>:<SelectedOrderHandoff api={api as unknown as PackProofApi} userId={owner} transactionId={snapshot.transactionId}/>);
  await userEvent.click(await screen.findByRole('button',{name:'Record on phone'}));
  await screen.findByText('The phone prompt expired. Try sending this order again.');
  expect(sends).toBe(2);expect(screen.queryByText('Order ready; open PackProof on your recording phone.')).not.toBeInTheDocument();
});
