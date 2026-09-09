import 'fake-indexeddb/auto';
import {webcrypto} from 'node:crypto';
import {Blob as NodeBlob} from 'node:buffer';
import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {BrowserCaptureJournal,recoverBrowserEngine,forgetBrowserEngine} from '../capture/engine';
import {CAPTURE_SCHEMA,CORE_VERSION,POLICY,type CaptureContext} from '../../../backend/src/capture/core';
const scope='https://api.example.test';
const context:CaptureContext={schema:CAPTURE_SCHEMA,captureId:'cap_browser',proofId:'proof_one',intentId:'intent_one',transactionId:'transaction_one',transactionDigest:'a'.repeat(64),actorId:'seller',policy:POLICY,expected:[],capabilities:{surface:'WEB',cameraSource:'UNKNOWN',timing:'MONOTONIC',barcode:false,itemVisibility:false,durableJournal:true,incrementalMedia:true,audio:false,deviceAuthentication:'UNAVAILABLE',appIntegrity:'UNAVAILABLE',storageReserveBytes:100000000,coreVersion:CORE_VERSION}};
const metadata={key:'seller:station',userId:'seller',apiScope:scope,order:{proofId:'proof_one',transactionId:'transaction_one',orderLabel:'Order one',itemSummary:'Lens'},uploadKey:'upload_one',captureSessionId:'cap_browser',finishConfirmed:false};
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('Blob',NodeBlob);});
afterEach(async()=>{await forgetBrowserEngine(scope,'seller','cap_browser');vi.unstubAllGlobals();});
it('recovers only committed chunks and the original account and server after process loss',async()=>{
 const journal=new BrowserCaptureJournal(scope,'seller',context,metadata);await journal.start();journal.append(new Blob(['first'],{type:'video/webm'}),1000);journal.append(new Blob(['second'],{type:'video/webm'}),2000);await journal.flush();
 const restored=await recoverBrowserEngine('seller',scope);expect(await restored!.file.text()).toBe('firstsecond');expect(restored!.interrupted).toBe(true);expect(restored!.captureContext).toEqual(context);
 expect(await recoverBrowserEngine('other',scope)).toBeNull();expect(await recoverBrowserEngine('seller','https://other.example.test')).toBeNull();
});
it('rejects mismatched ownership before a recording journal can be persisted',()=>{
 expect(()=>new BrowserCaptureJournal(scope,'other',context,metadata)).toThrow();expect(()=>new BrowserCaptureJournal(scope,'seller',context,{...metadata,order:{...metadata.order,proofId:'another'}})).toThrow();
});
it('keeps journal completion distinct from operator consent and cleans recovered copies after delivery',async()=>{
 const journal=new BrowserCaptureJournal(scope,'seller',context,metadata);await journal.start();journal.append(new Blob(['original'],{type:'video/webm'}),1000);await journal.finish();
 const restored=await recoverBrowserEngine('seller',scope);expect(restored!.interrupted).toBe(false);expect(restored!.finishConfirmed).toBe(false);
 await forgetBrowserEngine(scope,'seller',context.captureId);expect(await recoverBrowserEngine('seller',scope)).toBeNull();
});
