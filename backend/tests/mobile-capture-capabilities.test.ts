import { describe, expect, it } from 'vitest';
import type { ApiCapabilities } from '../../mobile/src/v2-api.ts';
import { requireCaptureCapabilities, requireOrderCaptureCapabilities, requiresDurableCaptureReceipts } from '../../mobile/src/capture/capabilities.ts';

function legacy():ApiCapabilities {return {schemaVersion:1,capture:{protocolVersions:[1],maxBytes:250_000_000,maxDurationSeconds:300,maxActiveUploads:2},preservation:{receiptVersions:[1],durableReceiptsRequired:false},sellerAttestation:{challengeVersions:[1],statementVersion:1,methods:['ANDROID_BIOMETRIC_STRONG']},release:{commit:null,version:null}};}
function current():ApiCapabilities {return {...legacy(),shippingReview:{requiredForObservedConflicts:true,noLabelAllowed:true},correctionPolicy:{importedFactsReadOnly:true,captureBindingLocksManualDetails:true},sellerAttestation:{...legacy().sellerAttestation,contextBindingVersion:1}};}
function setPath(value:ApiCapabilities,path:string,field:unknown) {const parts=path.split('.');let target:any=value;for(const part of parts.slice(0,-1))target=target[part];target[parts.at(-1)!]=field;return value;}

describe('new mobile order capture capability contract',()=>{
  it('blocks old server new-order starts while leaving its valid base and explicit journal completion policy intact',()=>{
    const response=legacy();
    expect(requireCaptureCapabilities(response,true)).toBe(response);
    expect(()=>requireOrderCaptureCapabilities(response)).toThrowError(expect.objectContaining({code:'CAPABILITY_UPDATE_REQUIRED'}));
    expect(requiresDurableCaptureReceipts(response)).toBe(false);
  });
  it.each([
    ['shippingReview',undefined],['shippingReview.requiredForObservedConflicts',false],['shippingReview.requiredForObservedConflicts','true'],
    ['shippingReview.noLabelAllowed',false],['correctionPolicy.importedFactsReadOnly',false],['correctionPolicy.captureBindingLocksManualDetails','true'],
    ['sellerAttestation.contextBindingVersion',undefined],['sellerAttestation.contextBindingVersion','1'],['sellerAttestation.contextBindingVersion',2],
  ])('rejects absent or malformed redesign support at %s', (path,value)=>{
    expect(()=>requireOrderCaptureCapabilities(setPath(current(),path,value))).toThrowError(expect.objectContaining({code:'CAPABILITY_UPDATE_REQUIRED'}));
  });
  it.each([
    ['capture.protocolVersions','1'],['capture.protocolVersions',[2]],['capture.maxBytes',0.5],['capture.maxDurationSeconds',0],['capture.maxActiveUploads',NaN],
    ['preservation.receiptVersions','1'],['preservation.durableReceiptsRequired','false'],
  ])('rejects malformed base capability %s with the controlled update error', (path,value)=>{
    expect(()=>requireCaptureCapabilities(setPath(current(),path,value),true)).toThrowError(expect.objectContaining({code:'CAPABILITY_UPDATE_REQUIRED'}));
  });
  it.each([['sellerAttestation.challengeVersions','1'],['sellerAttestation.methods','ANDROID_BIOMETRIC_STRONG']])('rejects malformed native attestation capability %s',(path,value)=>{
    expect(()=>requireCaptureCapabilities(setPath(current(),path,value),true)).toThrowError(expect.objectContaining({code:'CAPABILITY_ATTESTATION_REQUIRED'}));
  });
  it('permits the full current root contract without changing the server recording budgets',()=>{
    const response=current();expect(requireCaptureCapabilities(response,true)).toBe(response);expect(()=>requireOrderCaptureCapabilities(response)).not.toThrow();
  });
  it('preserves stage compatibility without requiring seller order or biometric capabilities',()=>{
    const response={...legacy(),sellerAttestation:undefined};
    expect(requireCaptureCapabilities(response,false)).toBe(response);
  });
  it('retains durable gates on unknown policy while ignoring unrelated new-order features for existing journals',()=>{
    for(const unknown of [null,undefined,{}, {...legacy(),schemaVersion:2},{...legacy(),preservation:{receiptVersions:[1],durableReceiptsRequired:true}}]) expect(requiresDurableCaptureReceipts(unknown)).toBe(true);
    expect(requiresDurableCaptureReceipts(setPath(current(),'shippingReview.requiredForObservedConflicts',false))).toBe(false);
    expect(requiresDurableCaptureReceipts(legacy())).toBe(false);
  });
});
