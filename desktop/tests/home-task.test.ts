import { describe, expect, it, vi } from 'vitest';
import { desktopHomeState, resolveDesktopHomeTask, uniqueAttentionCount } from '../src/renderer/home-task';
import { readCurrentProof } from '../src/main/current-proof';
import { schemas } from '../src/main/security';
import { stableRecommendation } from '../../mobile/src/experience/task-home';
import { summary, canonicalProof } from '../../web/src/tests/fixtures';
import type { PackProofDesktop, UploadView } from '../src/shared/contracts';

const second = { ...summary, proofId: 'second', createdAt: '2026-09-01T00:00:00Z' };
const state = (uploads: UploadView[] = []) => ({ proofs: [summary, second], uploads, orders: [], online: true, reconciled: true });
const job = (extra: Partial<UploadView> = {}): UploadView => ({ id: 'saved', proofId: summary.proofId, state: 'FAILED', label: 'Fixture shipment', byteSize: 40, progress: 0, createdAt: summary.createdAt, ...extra });
const ready = { ...canonicalProof, status: 'READY_FOR_EVIDENCE', evidence: [] };
function bridge() {
  return { proofs: { scope: vi.fn(async () => 'https://api.example.invalid'), current: vi.fn(async () => ready) }, uploads: { list: vi.fn(async (): Promise<UploadView[]> => []) } };
}
const cast = (value: ReturnType<typeof bridge>) => value as unknown as Pick<PackProofDesktop, 'proofs' | 'uploads'>;
describe('desktop Home shares task priority without changing queue ownership', () => {
  it('counts a Proof needing attention only once across duplicate summaries and failed jobs',()=>{
    expect(uniqueAttentionCount([summary,summary,second],[job(),job({id:'retry'}),job({id:'other',proofId:'third'})])).toBe(3);
    expect(uniqueAttentionCount([],[job(),job({id:'retry'})])).toBe(1);
    expect(uniqueAttentionCount([],[])).toBe(0);
  });
  it('prefers an ordinary incomplete Proof with deterministic and focused stable ties', () => {
    const first = desktopHomeState(state());
    expect(first.recommendation).toMatchObject({ kind: 'continue_proof', targetId: summary.proofId });
    const selected = desktopHomeState({ ...state(), selection: second.proofId });
    expect(selected.recommendation.targetId).toBe(second.proofId);
    expect(stableRecommendation(first.recommendation, selected, true).targetId).toBe(summary.proofId);
    expect(stableRecommendation(first.recommendation, desktopHomeState({ ...state(), proofs: [second] }), true).targetId).toBe(second.proofId);
  });
  it('prioritizes interrupted/failed local jobs, while healthy uploads and automatic retry stay passive', () => {
    for (const status of ['FAILED','INTERRUPTED','WAITING_FOR_AUTH','PAUSED']) expect(desktopHomeState(state([job({ state: status })])).recommendation).toMatchObject({ kind: 'review_upload', sessionId: 'saved' });
    for (const status of ['LOCAL','UPLOADING','RETRYING','WAITING_FOR_NETWORK','FINALIZING']) expect(desktopHomeState(state([job({ state: status })])).recommendation.targetId).toBe(second.proofId);
  });
  it('does not reinterpret desktop interrupted staging as a reviewable completed recording', () => {
    expect(desktopHomeState(state([job({ state: 'INTERRUPTED' })])).recommendation.kind).toBe('review_upload');
  });
  it('excludes viewer-only local jobs and keeps unknown states distinct from an empty account', () => {
    const viewer = { ...summary, role: 'BUYER' };
    expect(desktopHomeState({ ...state([job()]), proofs: [viewer] }).recommendation.kind).toBe('create_proof');
    const unknown = desktopHomeState({ ...state(), proofs: [{ ...summary, status: 'UNRECOGNIZED' }] });
    expect(unknown.empty).toBe(false); expect(unknown.recommendation.kind).toBe('reconcile');
    expect(desktopHomeState({ ...state(), proofs: [], reconciled: false }).empty).toBe(false);
  });
  it('allows account-bound local recovery offline without claiming fresh capture authority', async () => {
    const api = bridge(); api.uploads.list.mockResolvedValue([job()]);
    expect(await resolveDesktopHomeTask(cast(api), desktopHomeState({ ...state([job()]), online: false }).recommendation, 'user_seller', () => true)).toEqual({ page: 'uploads', proofId: summary.proofId });
    expect(api.proofs.current).not.toHaveBeenCalled(); expect(api.proofs.scope).toHaveBeenCalledTimes(2);
  });
  it('routes a stale completed or now-viewer-only target to its record, never the camera', async () => {
    const api = bridge(), action = desktopHomeState(state()).recommendation;
    api.proofs.current.mockResolvedValue({ ...ready, status: 'FINALIZED', finalizedAt: '2026-10-11T00:00:00Z' });
    expect(await resolveDesktopHomeTask(cast(api), action, 'user_seller', () => true)).toEqual({ page: 'proofs', proofId: summary.proofId });
    api.proofs.current.mockResolvedValue({ ...ready, participants: [] });
    expect((await resolveDesktopHomeTask(cast(api), action, 'user_seller', () => true))?.page).toBe('proofs');
  });
  it('rechecks a job that appeared during server validation before offering capture', async () => {
    const api = bridge(); api.uploads.list.mockResolvedValueOnce([]).mockResolvedValueOnce([job({ state: 'UPLOADING' })]);
    expect((await resolveDesktopHomeTask(cast(api), desktopHomeState(state()).recommendation, 'user_seller', () => true))?.page).toBe('uploads');
  });
  it('does not fall back to the camera for missing recovery targets or failed authority checks', async () => {
    const api = bridge(), action = desktopHomeState(state([job()])).recommendation;
    expect((await resolveDesktopHomeTask(cast(api), action, 'user_seller', () => true))?.page).toBe('proofs');
    api.proofs.current.mockRejectedValue(new Error('Unavailable'));
    await expect(resolveDesktopHomeTask(cast(api), action, 'user_seller', () => true)).rejects.toThrow('Unavailable');
  });
  it('discards a response after the account or active page changed', async () => {
    const api = bridge(); let current = true;
    api.proofs.current.mockImplementation(async () => { current = false; return ready; });
    expect(await resolveDesktopHomeTask(cast(api), desktopHomeState(state()).recommendation, 'user_seller', () => current)).toBeNull();
  });
});
describe('fresh Proof bridge boundary', () => {
  it('requires precisely a safe Proof ID and expected account ID', () => {
    expect(schemas.currentProof.safeParse(['proof_1','user_seller']).success).toBe(true);
    for (const args of [['proof_1'],['proof_1','user_seller','extra'],['../private','user_seller'],['proof_1','']]) expect(schemas.currentProof.safeParse(args).success).toBe(false);
  });
  it('checks account authority before and after the uncached read', async () => {
    let account = 'user_seller';
    const api = { assertAccount: vi.fn((owner: string) => { if (owner !== account) throw new Error('Account changed'); }), getProof: vi.fn(async () => { account = 'other'; return ready; }) };
    await expect(readCurrentProof(api, summary.proofId, 'other')).rejects.toThrow('Account changed');
    expect(api.getProof).not.toHaveBeenCalled();
    await expect(readCurrentProof(api, summary.proofId, 'user_seller')).rejects.toThrow('Account changed');
    expect(api.getProof).toHaveBeenCalledOnce();
  });
});
