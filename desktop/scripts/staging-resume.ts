/** Deliberately narrow recovery: only the finalized MP4 whose reviewed sharing check failed. */
export interface ResumeFixture {
  fixture: 'camera-recording.mp4'; sha256: string; byteSize: number; proofId: string;
  captureSessionId: string; evidenceId: string; manifestSha256: string; checks: string[];
}
export function validateResumeReport(value: unknown, expected: {
  mode: string; expectedCommit: string; migrationReceiptSha256: string;
  fixtureSha256: string; fixtureByteSize: number; now: number;
}): { runId: string; fixture: ResumeFixture } {
  const fail = (): never => { throw Object.assign(new Error('RESUME_REPORT_NOT_ELIGIBLE'), { code: 'RESUME_REPORT_NOT_ELIGIBLE' }); };
  if (!value || typeof value !== 'object') return fail();
  const report = value as Record<string, any>;
  if (expected.mode !== '--execute-protocol-fixture' || report.mode !== expected.mode || report.schemaVersion !== 1 || report.status !== 'FAIL' || report.resumedFrom ||
      !/^[a-f0-9-]{36}$/.test(report.runId) || report.sourceCommit !== expected.expectedCommit || report.migration?.receiptSha256 !== expected.migrationReceiptSha256 ||
      !Number.isFinite(Date.parse(report.completedAt)) || expected.now - Date.parse(report.completedAt) < 0 || expected.now - Date.parse(report.completedAt) > 86_400_000 ||
      report.failure?.stage !== 'share_video/mp4' || report.failure?.code !== 'DOWNLOAD_FAILED' || report.simulatedPlatformClaim !== true || report.desktopPlatformClaim !== 'win32' ||
      report.cleanup?.shareLinksRevoked !== true || report.cleanup?.localSessionCleared !== true || report.cleanup?.pendingAccessLinkIds?.length ||
      !Array.isArray(report.fixtures) || report.fixtures.length !== 1) return fail();
  const row = report.fixtures[0];
  if (row.fixture !== 'camera-recording.mp4' || row.sha256 !== expected.fixtureSha256 || row.byteSize !== expected.fixtureByteSize ||
      !/^proof_[A-Z0-9]{26}$/.test(row.proofId) || !/^cap_[A-Z0-9]{26}$/.test(row.captureSessionId) || !/^evd_[A-Z0-9]{26}$/.test(row.evidenceId) ||
      !/^[a-f0-9]{64}$/.test(row.manifestSha256) || !Array.isArray(row.checks) ||
      !['honest-post-capture-registration', 'stable-registration-replay', 'stable-upload-initialization', 'multipart-remote-recovery', 'server-assembly-digest', 'committed-original-digest', 'synthetic-explicit-shipping-declaration', 'authoritative-finalization', 'honest-desktop-provenance', 'frozen-manifest-replay', 'exact-owner-playback', 'byte-range-seeking', 'owner-export-zip'].every(check => row.checks.includes(check))) return fail();
  return { runId: report.runId, fixture: row as ResumeFixture };
}
