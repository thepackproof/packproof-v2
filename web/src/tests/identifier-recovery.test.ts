import 'fake-indexeddb/auto';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {PackProofApi} from '../api/client';
import type {IdentifierObservation,IdentifierPolicy,IdentifierReview} from '../../../backend/src/identifiers/types';
import {browserIdentifierJournal,checkpointBrowserIdentifiers,readBrowserIdentifierState,releaseBrowserIdentifierJournal} from '../capture/identifiers';
const policy:IdentifierPolicy={version:1,captureEnabled:true,autofillEnabled:true,reviewEnabled:true,surface:'WEB'};
let caseNumber=0;
beforeEach(()=>{caseNumber++;vi.stubGlobal('crypto',webcrypto);});
afterEach(()=>vi.unstubAllGlobals());
const decoded={rawText:'036000291452',rawBytes:null,decoderEncoding:null,symbology:'UPC_A',symbologyIdentifier:null,source:'LIVE_CAMERA_ANALYSIS' as const,mediaTimeMs:1200,timestampOrigin:'MONOTONIC_APPROXIMATE' as const,timestampUncertaintyMs:null,recordingRef:'session',adapterVersion:'test/1',decoderVersion:'test/1',capabilityProfile:'test/1',frameWidth:640,frameHeight:480,coordinateSpace:'ANALYSIS_FRAME_PIXELS',bounds:null};
function review(events:IdentifierObservation[]=[]):IdentifierReview{return {schemaVersion:1,enabled:true,policy,revision:events.length,acceptedEventIds:events.map(e=>e.clientEventId),acknowledgedSequence:events.at(-1)?.sequence??0,coverage:'COMPLETE',omittedEvents:0,reviewRequired:false,observations:events.map(event=>({observationId:event.clientEventId,clientEventId:event.clientEventId,sequence:event.sequence,route:'PRODUCT',state:'MATCH',identifiers:[],reasonCodes:[],product:null,expected:[],reviewRequired:false,decision:null,receivedAt:'2026-09-09T10:00:00Z',observation:event,supplemental:false})),checkpoint:null};}
function api(){return {recoveryScope:`https://identifier-${caseNumber}.test`,appendCaptureIdentifiers:vi.fn(async(_proof:string,_session:string,events:IdentifierObservation[])=>review(events)),getCaptureIdentifiers:vi.fn(async()=>review()),checkpointCaptureIdentifiers:vi.fn(async()=>review())};}
it('retains the same event and original scope across a lost response and browser journal reload',async()=>{
  const client=api(),typed=client as unknown as PackProofApi;
  client.appendCaptureIdentifiers.mockRejectedValueOnce(Object.assign(new Error('lost response'),{status:503}));
  const first=await browserIdentifierJournal(typed,'owner','proof','session',policy,()=>{});
  await first.observe(decoded);await first.flush();
  const sent=client.appendCaptureIdentifiers.mock.calls[0][2][0];
  releaseBrowserIdentifierJournal(typed,'owner','proof','session');
  const recovered=await browserIdentifierJournal(typed,'owner','proof','session',policy,()=>{});
  await recovered.flush();
  expect(client.appendCaptureIdentifiers.mock.calls[1][2][0]).toEqual(sent);
  expect((await readBrowserIdentifierState(typed,'owner','proof','session'))?.acknowledgedEventIds).toEqual([sent.clientEventId]);
  expect(await readBrowserIdentifierState(typed,'other-account','proof','session')).toBeUndefined();
});
it('blocks an acknowledged material mismatch and never forwards product-only observations as shipping',async()=>{
  const client=api(),typed=client as unknown as PackProofApi,shipping=vi.fn();
  const journal=await browserIdentifierJournal(typed,'owner','proof','session',policy,()=>{});await journal.observe(decoded);await journal.flush();
  const conflict=review(journal.snapshot().events);conflict.reviewRequired=true;conflict.observations[0].reviewRequired=true;conflict.observations[0].state='CONFLICT';
  client.getCaptureIdentifiers.mockResolvedValue(conflict);
  await expect(checkpointBrowserIdentifiers(typed,'owner','proof','session',policy,()=>{},shipping)).rejects.toMatchObject({code:'IDENTIFIER_REVIEW_REQUIRED'});
  expect(shipping).not.toHaveBeenCalled();expect(client.checkpointCaptureIdentifiers).not.toHaveBeenCalled();
});
it('permits the explicit server unavailable-coverage barrier when the optional endpoint is offline',async()=>{
  const client=api();client.getCaptureIdentifiers.mockRejectedValue(Object.assign(new Error('unavailable'),{status:503}));
  await expect(checkpointBrowserIdentifiers(client as unknown as PackProofApi,'owner','proof','session',policy,()=>{},vi.fn())).resolves.toBeNull();
  expect(client.checkpointCaptureIdentifiers).not.toHaveBeenCalled();
});
it('reuses a sealed checkpoint after a lost response even when supplemental observations advance the review',async()=>{
  const client=api(),typed=client as unknown as PackProofApi;
  const journal=await browserIdentifierJournal(typed,'owner','proof','session',policy,()=>{});await journal.observe(decoded);await journal.flush();
  const sealed=review(journal.snapshot().events);sealed.revision=3;
  sealed.checkpoint={id:'checkpoint',revision:1,sha256:'b'.repeat(64),coverage:'COMPLETE'};
  client.getCaptureIdentifiers.mockResolvedValue(sealed);
  await expect(checkpointBrowserIdentifiers(typed,'owner','proof','session',policy,()=>{},vi.fn())).resolves.toEqual(sealed);
  expect(client.checkpointCaptureIdentifiers).not.toHaveBeenCalled();
});
