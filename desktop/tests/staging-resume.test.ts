import { describe, expect, it } from 'vitest';
import { validateResumeReport } from '../scripts/staging-resume.js';

const expected = { mode: '--execute-protocol-fixture', expectedCommit: 'a'.repeat(40), migrationReceiptSha256: 'b'.repeat(64), fixtureSha256: 'c'.repeat(64), fixtureByteSize: 1701, now: Date.parse('2026-09-27T14:00:00Z') };
const eligible = () => ({ schemaVersion: 1, mode: expected.mode, status: 'FAIL', runId: 'd592e0af-d0c6-4a5f-b2ff-6f96e972f583', sourceCommit: expected.expectedCommit, migration: { receiptSha256: expected.migrationReceiptSha256 }, completedAt: '2026-09-27T13:00:00Z', simulatedPlatformClaim: true, desktopPlatformClaim: 'win32', failure: { stage: 'share_video/mp4', code: 'DOWNLOAD_FAILED' }, cleanup: { shareLinksRevoked: true, localSessionCleared: true }, fixtures: [{ fixture: 'camera-recording.mp4', sha256: expected.fixtureSha256, byteSize: 1701, proofId: `proof_${'A'.repeat(26)}`, captureSessionId: `cap_${'B'.repeat(26)}`, evidenceId: `evd_${'C'.repeat(26)}`, manifestSha256: 'd'.repeat(64), checks: ['honest-post-capture-registration', 'stable-registration-replay', 'stable-upload-initialization', 'multipart-remote-recovery', 'server-assembly-digest', 'committed-original-digest', 'synthetic-explicit-shipping-declaration', 'authoritative-finalization', 'honest-desktop-provenance', 'frozen-manifest-replay', 'exact-owner-playback', 'byte-range-seeking', 'owner-export-zip'] }] });
describe('staging continuation guard', () => {
  it('accepts only the exact prior finalized fixture with clean local/link cleanup', () => { expect(validateResumeReport(eligible(), expected).fixture.proofId).toBe(`proof_${'A'.repeat(26)}`); });
  it.each(['source', 'receipt', 'fixture', 'incomplete', 'cleanup', 'expired', 'multiple', 'native', 'repeated'])('rejects %s drift instead of bypassing the fresh account gate', reason => {
    const value: any = eligible();
    if (reason === 'source') value.sourceCommit = 'x'.repeat(40);
    if (reason === 'receipt') value.migration.receiptSha256 = 'x'.repeat(64);
    if (reason === 'fixture') value.fixtures[0].sha256 = 'x'.repeat(64);
    if (reason === 'incomplete') value.fixtures[0].checks = [];
    if (reason === 'cleanup') value.cleanup.shareLinksRevoked = false;
    if (reason === 'expired') value.completedAt = '2026-09-25T13:00:00Z';
    if (reason === 'multiple') value.fixtures.push(value.fixtures[0]);
    if (reason === 'native') value.mode = '--execute-native-host';
    if (reason === 'repeated') value.resumedFrom = { runId: 'prior' };
    expect(() => validateResumeReport(value, expected)).toThrow('RESUME_REPORT_NOT_ELIGIBLE');
  });
});
