import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { PackProofApi } from "../api/client";
import { selectFirstProofStudy, firstProofStudyForCapture, retainStudyAuth, completeStudyAuth, flushStudyTimings, recordStudyInteraction, rememberStudyStatus, resumeStationStudy, startStationStudy, type StationStudyTimer } from "../analytics/study-capture";

const datasetRef = `pr_${"a".repeat(32)}`;
const timers: StationStudyTimer[] = [];
function fixture() {
  const userId = crypto.randomUUID();
  const status = { enabled: true, granted: true, datasetRef, statementVersion: "capture-timing-study-v1" };
  const studyRequest = vi.fn(async (path: string, _method?: string, _body?: unknown) =>
    path === "/consent" ? status : path === "/timings/start" ? { attemptRef: `pr_${"b".repeat(32)}` } : {});
  const api = { recoveryScope: "https://study-test.example", studyRequest } as unknown as PackProofApi;
  const events = () => studyRequest.mock.calls.filter(call => call[0] === "/timings").map(call => call[2] as Record<string, unknown>);
  const starts = () => studyRequest.mock.calls.filter(call => call[0] === "/timings/start").map(call => call[2] as Record<string, unknown>);
  return { api, userId, status, studyRequest, events, starts };
}
beforeEach(() => localStorage.clear());
afterEach(() => { for (const timer of timers.splice(0)) timer.suspend(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("does not request study APIs or install task listeners without explicit consent", async () => {
  const f = fixture(), listen = vi.spyOn(window, "addEventListener");
  expect(await startStationStudy(f.api, f.userId)).toBeNull();
  await recordStudyInteraction(f.api, f.userId, "share_created");
  expect(f.studyRequest).not.toHaveBeenCalled();
  expect(listen).not.toHaveBeenCalled();
});

it("keeps one pending task across recoverable problems and navigation, then completes its original journal", async () => {
  const f = fixture(); rememberStudyStatus(f.api, f.userId, f.status);
  const timer = (await startStationStudy(f.api, f.userId))!; timers.push(timer);
  timer.event("order_selected"); timer.phase("recording"); timer.event("recording_started");
  timer.problem("network"); timer.suspend();
  await flushStudyTimings(f.api, f.userId);
  await waitFor(() => expect(f.events().some(event => event.errorCode === "network")).toBe(true));
  expect(f.events().every(event => event.outcome === "pending")).toBe(true);
  const resumed = await resumeStationStudy(f.api, f.userId, timer.localRef);
  expect(resumed).toBe(timer);
  resumed!.event("recovery_started"); resumed!.phase("upload"); resumed!.event("upload_pending");
  resumed!.phase("finalization"); resumed!.event("server_completed"); resumed!.end("succeeded");
  await flushStudyTimings(f.api, f.userId);
  await waitFor(() => expect(f.events().some(event => event.phase === "ended")).toBe(true));
  expect(f.starts()).toHaveLength(1);
  expect(f.events().filter(event => event.phase === "ended")).toHaveLength(1);
  expect(f.events().at(-1)).toMatchObject({ outcome: "succeeded", phase: "ended" });
  expect(f.events().map(event => event.interaction).filter(Boolean)).toEqual(["order_selected", "recording_started", "recovery_started", "upload_pending", "server_completed"]);
  expect(JSON.stringify(f.events())).not.toContain(timer.localRef);
  expect(JSON.stringify(f.events())).not.toContain(f.userId);
});

it("does not create recovery tasks for missing journals or another signed-in account", async () => {
  const f = fixture(); rememberStudyStatus(f.api, f.userId, f.status);
  const timer = (await startStationStudy(f.api, f.userId))!; timers.push(timer); timer.suspend();
  const otherUser = crypto.randomUUID(); rememberStudyStatus(f.api, otherUser, f.status);
  expect(await resumeStationStudy(f.api, otherUser, timer.localRef)).toBeNull();
  expect(await resumeStationStudy(f.api, f.userId, crypto.randomUUID())).toBeNull();
  await flushStudyTimings(f.api, f.userId);
  expect(f.starts()).toHaveLength(1);
});

it("records sharing separately with only whitelisted interaction fields and an actual valid build SHA", async () => {
  const f = fixture(); rememberStudyStatus(f.api, f.userId, f.status);
  vi.stubEnv("VITE_PACKPROOF_BUILD_SHA", "c".repeat(40));
  await recordStudyInteraction(f.api, f.userId, "share_created");
  await flushStudyTimings(f.api, f.userId);
  await waitFor(() => expect(f.events().some(event => event.phase === "ended")).toBe(true));
  expect(f.starts()).toEqual([expect.objectContaining({ taskKind: "interface_action", buildSha: "c".repeat(40) })]);
  expect(f.events().find(event => event.interaction === "share_created")).toMatchObject({ phase: "confirmation", outcome: "pending" });
  const allowed = new Set(["phase", "outcome", "elapsedMs", "activeMs", "offlineMs", "unattendedMs", "interaction", "operationNonce", "datasetRef", "attemptRef", "errorCode"]);
  expect(f.events().every(event => Object.keys(event).every(key => allowed.has(key)))).toBe(true);
  vi.stubEnv("VITE_PACKPROOF_BUILD_SHA", "not-a-release-sha");
  await recordStudyInteraction(f.api, f.userId, "share_created");
  await flushStudyTimings(f.api, f.userId);
  await waitFor(() => expect(f.starts()).toHaveLength(2));
  expect(f.starts()[1]).not.toHaveProperty("buildSha");
});


it("retains the synchronous choice timestamp and lifecycle dedup across navigation, then starts a fresh task after completion", async()=>{
 const f=fixture();rememberStudyStatus(f.api,f.userId,f.status);
 const at=new Date('2026-10-11T12:00:00.000Z');
 const chosen=await selectFirstProofStudy(f.api,f.userId,'home',at);timers.push(chosen!);
 chosen!.event('capture_ready',{once:true,observedAt:new Date(at.getTime()+2000)});
 chosen!.suspend();const resumed=await firstProofStudyForCapture(f.api,f.userId);
 expect(resumed).toBe(chosen);resumed!.event('capture_ready',{once:true});
 await flushStudyTimings(f.api,f.userId);
 await waitFor(()=>expect(f.events().filter(row=>row.interaction==='capture_ready')).toHaveLength(1));
 expect(f.starts()).toHaveLength(1);expect(f.starts()[0]).toMatchObject({clientStartedAt:at.toISOString(),flowVersion:1,platform:'web',entrySource:'home'});
 expect(f.events().find(row=>row.interaction==='capture_ready')).toMatchObject({clientOccurredAt:new Date(at.getTime()+2000).toISOString(),networkState:'online'});
 resumed!.end('succeeded');await flushStudyTimings(f.api,f.userId);
 const next=await selectFirstProofStudy(f.api,f.userId,'manual');timers.push(next!);expect(next!.localRef).not.toBe(chosen!.localRef);
});

it("retains previously consented reauthentication without sending before sign-in and never crosses accounts",async()=>{
 const f=fixture();const at=new Date('2026-10-11T13:00:00.000Z');
 retainStudyAuth(f.api,f.userId,'auth_started',at);await completeStudyAuth(f.api,f.userId);expect(f.studyRequest).not.toHaveBeenCalled();
 rememberStudyStatus(f.api,f.userId,f.status);retainStudyAuth(f.api,f.userId,'auth_started',at);retainStudyAuth(f.api,f.userId,'auth_failed',new Date(at.getTime()+1000));
 expect(f.studyRequest).not.toHaveBeenCalled();
 const other=crypto.randomUUID();rememberStudyStatus(f.api,other,f.status);await completeStudyAuth(f.api,other);expect(f.studyRequest).not.toHaveBeenCalled();
 await Promise.all([completeStudyAuth(f.api,f.userId,new Date(at.getTime()+3000)),completeStudyAuth(f.api,f.userId,new Date(at.getTime()+3000))]);
 await waitFor(()=>expect(f.events().some(row=>row.interaction==='auth_completed')).toBe(true));
 expect(f.starts()).toHaveLength(1);expect(f.starts()[0]).toMatchObject({taskKind:'interface_action',entrySource:'auth',clientStartedAt:at.toISOString()});
 expect(f.events().filter(row=>row.interaction).map(row=>row.interaction)).toEqual(['auth_started','auth_failed','auth_completed']);
 await completeStudyAuth(f.api,f.userId);expect(f.starts()).toHaveLength(1);
});

it("fails closed for unavailable consent storage without blocking a task",async()=>{
 const f=fixture();vi.spyOn(Storage.prototype,'getItem').mockImplementation(()=>{throw new Error('unavailable');});
 expect(await selectFirstProofStudy(f.api,f.userId,'home')).toBeNull();expect(f.studyRequest).not.toHaveBeenCalled();
});


it("does not duplicate a flushed auth lifecycle when local buffer cleanup fails",async()=>{
 const f=fixture();rememberStudyStatus(f.api,f.userId,f.status);retainStudyAuth(f.api,f.userId,'auth_started');
 const original=Storage.prototype.removeItem;const remove=vi.spyOn(Storage.prototype,'removeItem').mockImplementation(function(this:Storage,key:string){if(key.startsWith('packproof-study-auth:'))throw new Error('cleanup failed');return original.call(this,key);});
 await completeStudyAuth(f.api,f.userId);await flushStudyTimings(f.api,f.userId);expect(f.starts()).toHaveLength(1);
 remove.mockRestore();await completeStudyAuth(f.api,f.userId);expect(f.starts()).toHaveLength(1);
});


it("withdrawal immediately fences local callbacks even when preference storage removal fails",async()=>{
 const f=fixture();rememberStudyStatus(f.api,f.userId,f.status);const timer=await selectFirstProofStudy(f.api,f.userId,'home');timers.push(timer!);await flushStudyTimings(f.api,f.userId);
 const count=f.events().length;vi.spyOn(Storage.prototype,'removeItem').mockImplementation(()=>{throw new Error('storage failed');});
 rememberStudyStatus(f.api,f.userId,{enabled:true,granted:false});timer!.event('capture_saved');retainStudyAuth(f.api,f.userId,'auth_started');
 expect(await selectFirstProofStudy(f.api,f.userId,'manual')).toBeNull();await new Promise(resolve=>setTimeout(resolve,10));expect(f.events()).toHaveLength(count);
});
