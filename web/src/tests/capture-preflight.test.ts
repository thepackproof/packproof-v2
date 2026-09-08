import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackProofApi } from '../api/client';
import { capturePreflight, requiresDurableReceipts, type CaptureCapabilities } from '../capture-preflight';

function legacy():CaptureCapabilities{return {schemaVersion:1,capture:{protocolVersions:[1],maxBytes:250_000_000,maxDurationSeconds:300,maxActiveUploads:2},preservation:{receiptVersions:[1],durableReceiptsRequired:false}};}
function current():CaptureCapabilities{return {...legacy(),shippingReview:{requiredForObservedConflicts:true,noLabelAllowed:true},correctionPolicy:{importedFactsReadOnly:true,captureBindingLocksManualDetails:true},sellerAttestation:{contextBindingVersion:1}};}
function api(value:unknown) {return {getCapabilities:vi.fn(async()=>value)} as unknown as PackProofApi;}
function setPath(capabilities:CaptureCapabilities,path:string,value:unknown){let target:any=capabilities;const parts=path.split('.');for(const part of parts.slice(0,-1))target=target[part];target[parts.at(-1)!]=value;return capabilities;}
const estimate=vi.fn();const persist=vi.fn();
beforeEach(()=>{vi.clearAllMocks();estimate.mockResolvedValue({quota:1_000_000_000,usage:0});persist.mockResolvedValue(true);Object.defineProperty(navigator,'storage',{configurable:true,value:{estimate,persist}});});

describe('browser new-order capability gates',()=>{
  it('blocks older order recording before browser-storage work while still completing compatible old journals',async()=>{
    const client=api(legacy());
    await expect(capturePreflight(client,true)).rejects.toThrow('Packing is being updated');
    expect(estimate).not.toHaveBeenCalled();expect(persist).not.toHaveBeenCalled();
    expect(await requiresDurableReceipts(client)).toBe(false);
  });
  it.each([
    ['shippingReview',undefined],['shippingReview.requiredForObservedConflicts',false],['shippingReview.requiredForObservedConflicts','true'],['shippingReview.noLabelAllowed',false],
    ['correctionPolicy.importedFactsReadOnly',false],['correctionPolicy.captureBindingLocksManualDetails','true'],['sellerAttestation.contextBindingVersion','1'],['sellerAttestation.contextBindingVersion',2],
  ])('fails closed on missing or malformed redesign field %s',async(path,value)=>{
    await expect(capturePreflight(api(setPath(current(),path,value)),true)).rejects.toThrow('Packing is being updated');
    expect(estimate).not.toHaveBeenCalled();expect(persist).not.toHaveBeenCalled();
  });
  it.each([
    ['capture.protocolVersions','1'],['capture.protocolVersions',[2]],['preservation.receiptVersions','1'],['preservation.receiptVersions',[2]],['preservation.durableReceiptsRequired','false'],
  ])('rejects malformed protocol/receipt declaration at %s',async(path,value)=>{
    await expect(capturePreflight(api(setPath(current(),path,value)),true)).rejects.toThrow('Update PackProof before recording');
    expect(estimate).not.toHaveBeenCalled();
  });
  it.each([['capture.maxBytes',0.5],['capture.maxBytes',Infinity],['capture.maxDurationSeconds',0],['capture.maxActiveUploads',0]])('rejects invalid resource budget %s',async(path,value)=>{
    await expect(capturePreflight(api(setPath(current(),path,value)),true)).rejects.toThrow('Recording is temporarily unavailable');
    expect(estimate).not.toHaveBeenCalled();
  });
  it('accepts the full order contract and returns its actual recording budget',async()=>{
    const response=current();expect(await capturePreflight(api(response),true)).toBe(response);
    expect(estimate).toHaveBeenCalledTimes(1);expect(persist).toHaveBeenCalledTimes(1);
  });
  it('preserves stage recording compatibility without requiring seller order features',async()=>{
    const response=legacy();expect(await capturePreflight(api(response),false)).toBe(response);expect(persist).toHaveBeenCalledTimes(1);
  });
  it('keeps saved-recording completion independent of new-order feature flags',async()=>{
    expect(await requiresDurableReceipts(api({schemaVersion:1,preservation:{receiptVersions:[1],durableReceiptsRequired:false}}))).toBe(false);
    expect(await requiresDurableReceipts(api(setPath(current(),'shippingReview.requiredForObservedConflicts',false)))).toBe(false);
    for(const value of [null,{}, {schemaVersion:2,preservation:{receiptVersions:[1],durableReceiptsRequired:false}}, {...legacy(),preservation:{receiptVersions:[1],durableReceiptsRequired:true}}]) expect(await requiresDurableReceipts(api(value))).toBe(true);
    const offline={getCapabilities:vi.fn(async()=>{throw new Error('offline');})} as unknown as PackProofApi;
    expect(await requiresDurableReceipts(offline)).toBe(true);
  });
});
