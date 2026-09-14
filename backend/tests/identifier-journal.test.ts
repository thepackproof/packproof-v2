import { describe, expect, it, vi } from 'vitest';
import { IdentifierJournal } from '../src/identifiers/journal.js';
import { IDENTIFIER_LIMITS, identifierUtf8Bytes } from '../src/identifiers/core.js';
import type { DecodedIdentifier, IdentifierJournalState, IdentifierObservation, IdentifierReview } from '../src/identifiers/types.js';

const initial = (): IdentifierJournalState => ({schemaVersion:1,apiScope:'https://api.test',userId:'u1',proofId:'p1',sessionId:'s1',
  policy:{version:1,surface:'ANDROID',captureEnabled:true,autofillEnabled:true,reviewEnabled:true}, events:[],acknowledgedEventIds:[],
  omittedEvents:0,coverage:'COMPLETE',review:null,checkpointEventId:null});
const decoded = (rawText = 'SKU-1', mediaTimeMs = 25, symbology = 'Code128'): DecodedIdentifier => ({rawText,rawBytes:null,
  decoderEncoding:null,symbology,symbologyIdentifier:null,source:'LIVE_CAMERA_ANALYSIS',mediaTimeMs,
  timestampOrigin:'MONOTONIC_APPROXIMATE',timestampUncertaintyMs:120,recordingRef:'s1',adapterVersion:'test/1',decoderVersion:'test/1',
  capabilityProfile:'ANDROID_REFERENCE_UNQUALIFIED',frameWidth:640,frameHeight:480,coordinateSpace:'ROTATED_ANALYSIS_PIXELS',bounds:null});
const review = (events: IdentifierObservation[], revision = 1): IdentifierReview => ({schemaVersion:1,enabled:true,policy:initial().policy,
  revision,acceptedEventIds:events.map(e => e.clientEventId),acknowledgedSequence:Math.max(0,...events.map(e => e.sequence)),
  coverage:'COMPLETE',omittedEvents:0,reviewRequired:false,observations:[],checkpoint:null});
function harness(state = initial()) {
  let number = state.events.length; let now = 0; let scope = true;
  const persisted: IdentifierJournalState[] = [];
  const persist = vi.fn(async (s: IdentifierJournalState) => {persisted.push(s);});
  const send = vi.fn(async (events: IdentifierObservation[]) => review(events));
  const journal = new IdentifierJournal(state,{persist,send,makeId:()=>`event-${++number}`,
    assertScope:()=>{if (!scope) throw new Error('Account changed');},now:()=>now,random:()=>0.5});
  return {journal,persist,send,persisted,advance:()=>{now += 10000;},switchAccount:()=>{scope = false;}};
}

describe('durable bounded identifier journal', () => {
  it('persists before send, coalesces sightings, and keeps independent product and label observations', async () => {
    const h = harness();
    await h.journal.observe(decoded('042100005264',10,'UPC_A'));
    await h.journal.observe(decoded('042100005264',100,'UPC_A'));
    await h.journal.observe(decoded('1Z999AA10123456784',150));
    expect(h.send).not.toHaveBeenCalled();
    expect(h.journal.snapshot().events).toHaveLength(2);
    const first = h.journal.snapshot().events[0];
    h.send.mockImplementation(async events => {
      expect(h.persisted.at(-1)?.events).toEqual(events); return review(events);
    });
    await h.journal.flush(); await h.journal.observe(decoded('042100005264',300,'UPC_A'));
    expect(h.journal.snapshot().events[0]).toEqual(first);
    expect(h.journal.snapshot().acknowledgedEventIds).toEqual(['event-1','event-2']);
    await h.journal.flush(); expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('retains encoded-video provenance separately from an approximate live detection', async () => {
    const h = harness(); await h.journal.observe(decoded());
    await h.journal.observe({...decoded(),source:'ENCODED_VIDEO_FRAME',timestampOrigin:'ENCODED_MEDIA',timestampUncertaintyMs:0});
    expect(h.journal.snapshot().events.map(e => e.source)).toEqual(['LIVE_CAMERA_ANALYSIS','ENCODED_VIDEO_FRAME']);
  });
  it('recovers exact IDs/body after a lost response, with bounded backoff', async () => {
    const h = harness(); await h.journal.observe(decoded());
    h.send.mockRejectedValueOnce(new Error('Lost response'));
    await h.journal.flush(); await h.journal.flush();
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.journal.snapshot().coverage).toBe('PARTIAL');
    const restored = harness(h.persisted.at(-1)); await restored.journal.flush();
    expect(restored.send.mock.calls[0][0]).toEqual(h.send.mock.calls[0][0]);
    expect(restored.journal.snapshot().acknowledgedEventIds).toEqual(['event-1']);
  });
  it('serializes a single request and leaves new observations for a later bounded flush', async () => {
    const h = harness(); await h.journal.observe(decoded());
    let finish!: (value: IdentifierReview) => void;
    h.send.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const first = h.journal.flush(); const duplicate = h.journal.flush();
    expect(first).toBe(duplicate);
    await vi.waitFor(() => expect(h.send).toHaveBeenCalledTimes(1));
    await h.journal.observe(decoded('SKU-2',30));
    finish(review(h.send.mock.calls[0][0])); await first;
    expect(h.journal.snapshot().acknowledgedEventIds).toEqual(['event-1']);
    await h.journal.flush(); expect(h.send.mock.calls[1][0].map(e => e.clientEventId)).toEqual(['event-2']);
  });
  it('retries only unacknowledged IDs from a partially accepted batch', async () => {
    const h = harness(); await h.journal.observe(decoded()); await h.journal.observe(decoded('SKU-2'));
    h.send.mockImplementationOnce(async events => review(events.slice(0,1)));
    await h.journal.flush(); await h.journal.flush();
    expect(h.send.mock.calls[1][0].map(e => e.clientEventId)).toEqual(['event-2']);
  });
  it('bounds batches by both byte size and count', async () => {
    const h = harness();
    for (let i=0;i<53;i++) await h.journal.observe(decoded(`${i}-${'x'.repeat(3900)}`,i));
    await h.journal.flush();
    expect(h.send.mock.calls.length).toBeGreaterThan(1);
    for (const [events] of h.send.mock.calls) {
      expect(events.length).toBeLessThanOrEqual(50);
      expect(identifierUtf8Bytes(JSON.stringify({events}))).toBeLessThanOrEqual(128*1024);
    }
    expect(h.journal.snapshot().acknowledgedEventIds).toHaveLength(53);
  });
  it('reserves observation slots for opaque shipping candidates when product noise fills general capacity', async () => {
    const h = harness(); const maxGeneral = IDENTIFIER_LIMITS.sessionEvents - IDENTIFIER_LIMITS.reservedOpaqueEvents;
    for (let i=0;i<maxGeneral+1;i++) await h.journal.observe(decoded(String(i).padStart(12,'0'),i,'UPC_A'));
    expect(h.journal.snapshot().events).toHaveLength(maxGeneral);
    for (let i=0;i<IDENTIFIER_LIMITS.reservedOpaqueEvents+1;i++) await h.journal.observe(decoded(`LABEL-${i}`,1000+i));
    expect(h.journal.snapshot().events).toHaveLength(IDENTIFIER_LIMITS.sessionEvents);
    expect(h.journal.snapshot()).toMatchObject({omittedEvents:2,coverage:'PARTIAL'});
  });
  it('never persists unrelated QR secrets or sends before storage succeeds', async () => {
    const h = harness();
    await h.journal.observe({...decoded('WIFI:S:secret;P:password;;',0,'QRCode'),rawBytes:'secret-base64'});
    expect(JSON.stringify(h.persisted)).not.toContain('secret');
    h.persist.mockRejectedValue(new Error('disk full'));
    await expect(h.journal.observe(decoded('SKU-2'))).rejects.toMatchObject({code:'IDENTIFIER_STORAGE_UNAVAILABLE'});
    await h.journal.flush(); expect(h.send).not.toHaveBeenCalled();
    await expect(h.journal.drain()).rejects.toMatchObject({code:'IDENTIFIER_STORAGE_UNAVAILABLE'});
  });
  it('locks restored work and in-flight responses to original account/API', async () => {
    const h = harness(); await h.journal.observe(decoded());
    h.send.mockImplementation(async events => {h.switchAccount(); return review(events);});
    await expect(h.journal.flush()).rejects.toMatchObject({code:'IDENTIFIER_SCOPE_MISMATCH'});
    expect(() => h.journal.snapshot()).toThrow('original account');
  });
  it('does not convert known review conflicts or server 409s into optional outages', async () => {
    const h = harness(); await h.journal.observe(decoded());
    const conflict = {...review([]),reviewRequired:true}; await h.journal.updateReview(conflict);
    h.send.mockRejectedValueOnce(new Error('offline'));
    await h.journal.flush(); expect(h.journal.snapshot().review?.reviewRequired).toBe(true);
    h.advance(); h.send.mockRejectedValueOnce({status:409,code:'IDENTIFIER_IDEMPOTENCY_CONFLICT'});
    await expect(h.journal.flush()).rejects.toMatchObject({status:409});
  });
  it('persists review/checkpoint updates and rejects stale review replacement', async () => {
    const h = harness(); await h.journal.observe(decoded());
    const latest = {...review(h.journal.snapshot().events,5),reviewRequired:true};
    await h.journal.updateReview(latest); await h.journal.updateReview(review([],4));
    await h.journal.setCheckpointEventId('checkpoint-operation-1');
    await h.journal.updateReview({...latest,checkpoint:{id:'server-checkpoint-id',revision:5,sha256:'a'.repeat(64),coverage:'COMPLETE'}});
    await h.journal.updateReview(latest); // An earlier GET can arrive after the checkpoint response at the same revision.
    await h.journal.drain();
    expect(h.persisted.at(-1)).toMatchObject({review:{revision:5,reviewRequired:true},checkpointEventId:'checkpoint-operation-1'});
    expect(h.journal.snapshot().review?.checkpoint?.id).toBe('server-checkpoint-id');
    h.journal.markUnavailable(); await h.journal.drain();
    expect(h.persisted.at(-1)?.coverage).toBe('PARTIAL');
    const changed = h.journal.snapshot(); changed.events[0].rawText='mutated';
    expect(h.journal.snapshot().events[0].rawText).toBe('SKU-1');
  });
  it('keeps local coverage complete for a provisional review and respects a sealed coverage gap', async () => {
    const h = harness(); await h.journal.observe(decoded());
    const provisional = {...review(h.journal.snapshot().events),coverage:'PARTIAL' as const};
    await h.journal.updateReview(provisional);
    expect(h.journal.snapshot().coverage).toBe('COMPLETE');
    await h.journal.updateReview({...provisional,checkpoint:{id:'sealed',revision:1,sha256:'a'.repeat(64),coverage:'PARTIAL'}});
    expect(h.journal.snapshot().coverage).toBe('PARTIAL');
  });
  it('does not mutate or transmit with a pinned flag-off policy', async () => {
    const state = initial(); state.policy.captureEnabled=false;
    const h = harness(state); await h.journal.observe(decoded()); await h.journal.flush();
    expect(h.journal.snapshot().events).toHaveLength(0); expect(h.send).not.toHaveBeenCalled();
  });
  it.each([{status:404,code:'HTTP_ERROR'},{status:405,code:'HTTP_ERROR'},{status:422,code:'IDENTIFIER_DISABLED'},{code:'IDENTIFIER_CAPABILITY_UNAVAILABLE'}])
    ('stops repeated optional mutations after backend rollback: %s', async error => {
      const h = harness(); await h.journal.observe(decoded()); h.send.mockRejectedValue(error);
      await h.journal.flush(); h.advance(); await h.journal.observe(decoded('SKU-2')); await h.journal.flush();
      expect(h.send).toHaveBeenCalledTimes(1);
      expect(h.journal.snapshot()).toMatchObject({coverage:'PARTIAL',acknowledgedEventIds:[]});
      expect(h.journal.snapshot().events).toHaveLength(2);
    });
});
