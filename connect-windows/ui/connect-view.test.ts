import { describe, expect, it } from 'vitest';
import { deriveConnectView } from './connect-view';
import { analysis, configuration, selected } from './test-fixtures';
import type { ConnectStatus, TransportObservation } from './types';
const now = Date.parse('2026-11-16T14:00:00Z');
const probe: TransportObservation = { state: 'compatible', expectedRulesVersion: analysis.binding.rulesVersion, observedRulesVersion: analysis.binding.rulesVersion, sourceContracts: ['packproof.scheduled-csv/v2'], attemptedAt: new Date(now-1000).toISOString(), succeededAt:new Date(now-500).toISOString(), expiresAt: new Date(now+119000).toISOString() };
const view = (status: ConnectStatus = selected, transport: TransportObservation | undefined = probe) => deriveConnectView(status, status.analysis, transport, now);
describe('authenticated readiness', () => {
  it('accepts a fresh exact contract without counting absent optional fields as errors', () => {
    const current = view(); expect(current.stage).toBe('review'); expect(current.prerequisites.localReady).toBe(true); expect(current.prerequisites.remoteCompatible).toBe(true); expect(current.ctaDisabledReason).toBeUndefined();
  });
  it.each([
    ['no capability observation', undefined],
    ['v1 only', { ...probe, sourceContracts: ['packproof.scheduled-csv/v1'] }],
    ['different rules', { ...probe, observedRulesVersion: 'different' }],
    ['missing response rules', { ...probe, observedRulesVersion: undefined }],
    ['expired response', { ...probe, expiresAt:new Date(now).toISOString() }],
    ['future observation', { ...probe, attemptedAt:new Date(now+1).toISOString() }],
    ['unbounded response', { ...probe, expiresAt:new Date(now+86400000).toISOString() }],
    ['no authenticated success', { ...probe, succeededAt:undefined }],
  ] satisfies Array<[string, TransportObservation | undefined]>)('fails closed for %s while preserving local review', (_, transport) => {
    const result = deriveConnectView(selected, analysis, transport, now); expect(result.stage).toBe('review'); expect(result.prerequisites.localReady).toBe(true); expect(result.prerequisites.remoteCompatible).toBe(false); expect(result.ctaDisabledReason).toBeTruthy();
  });
  it('ignores a historical network error after a successful probe', () => { const result=view({...selected, health:{...selected.health,lastErrorCode:'NETWORK_UNAVAILABLE'}}); expect(result.problem).toBeUndefined(); });
  it('distinguishes unreachable, unauthenticated and incompatible responses', () => {
    expect(view(selected,{...probe,state:'unreachable'}).problem?.kind).toBe('network');
    expect(view(selected,{...probe,state:'unauthenticated'}).problem?.kind).toBe('permission');
    expect(view(selected,{...probe,state:'outdated'}).problem?.kind).toBe('compatibility');
  });
  it.each(['fileSha256','folderDigest','sourceBindingId'] as const)('rejects a changed %s binding', key => {
    const changed = { ...analysis, binding:{...analysis.binding,[key]:'changed'} }; expect(deriveConnectView(selected,changed,probe,now).prerequisites.localReady).toBe(false);
  });
  it('requires completed service checks before the approval request', () => {expect(view({...selected, checks:[]}).prerequisites.serviceReady).toBe(false);});
});
describe('authoritative approval progress', () => {
  const active:ConnectStatus={...selected,config:configuration,configRevision:1,state:'active',verification:{complete:true,recordId:'proof-synthetic',configRevision:1,fileSha256:selected.source!.fileSha256}};
  it('does not confuse queued uploads with canonical records or active collection',()=>{
    const current:ConnectStatus={...selected,config:configuration,setup:{running:true,phase:'first_import_pending'},preview:{id:'import-fixture',previewVersion:'v',state:'queued',original:{sha256:selected.source!.fileSha256!,byteSize:200},counts:{valid:1},rows:[],recordIds:['unverified-proof']}};
    const result=view(current);expect(result.stage).toBe('activation');expect(result.prerequisites.batchApproved).toBe(true);expect(result.prerequisites.recordVerified).toBe(false);expect(result.recordLink).toBeUndefined();expect(result.progressPhase).toBe('first_import');
  });
  it('requires acknowledged active service and current canonical verification',()=>{
    expect(view(active)).toMatchObject({stage:'home',connectionState:'Active',progressPhase:'connected',recordLink:{recordId:'proof-synthetic'}});
    expect(view({...active,verification:{...active.verification!,fileSha256:'stale'}}).prerequisites.serviceAcknowledged).toBe(false);
    const awaitingRecurring=view({...active,state:'ready_to_activate',setup:{running:true,phase:'recurring_approval_pending'}});
    expect(awaitingRecurring.prerequisites.serviceAcknowledged).toBe(false); expect(awaitingRecurring.stage).toBe('activation'); expect(awaitingRecurring.progressPhase).toBe('ongoing_collection');
  });
  it('does not display active when the current connection probe is offline or expired',()=>{
    expect(view(active,{...probe,state:'unreachable'})).toMatchObject({stage:'home',connectionState:'Offline'});
    expect(deriveConnectView(active,active.analysis,undefined,now)).toMatchObject({stage:'home',connectionState:'Checking'});
  });
  it('preserves a source home through pause and revocation without exposing revoked record access',()=>{
    expect(view({...active,state:'paused'})).toMatchObject({stage:'home',connectionState:'Paused'});
    const revoked=view({...active,state:'revoked'});expect(revoked.stage).toBe('home');expect(revoked.recordLink).toBeUndefined();expect(revoked.prerequisites.serviceAcknowledged).toBe(false);
  });
  it('keeps a supported approved v1 source active without applying v2 semantics',()=>{
    const legacyConfig = {...configuration,sourceContract:{...configuration.sourceContract!,schema:'packproof.scheduled-csv/v1' as const,rulesVersion:undefined}};
    const legacy = {...active,analysis:undefined,config:legacyConfig};
    expect(view(legacy,{...probe,state:'unsupported',observedRulesVersion:undefined,sourceContracts:['packproof.scheduled-csv/v1']})).toMatchObject({stage:'home',connectionState:'Active'});
  });
  it('does not infer configuration permission from a pending proposal',()=>{expect(view({...selected,config:configuration,pendingProposal:configuration}).prerequisites.configApproved).toBe(false);});
});
