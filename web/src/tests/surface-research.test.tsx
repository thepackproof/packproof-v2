import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SurfaceFingerprintPanel, researchStatus } from '../components/SurfaceFingerprintPanel';
import { ResearchBuildBanner, surfaceReviewEnabled } from '../components/SurfaceResearchReview';
import { surfaceCanonicalJson, surfaceCommand, type SurfaceRecord, type SurfaceSummary, type SurfaceTransport } from '../api/surface-types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); sessionStorage.clear(); });
const source = {sourceId: 'source-a', sha256: 'a'.repeat(64), contentType: 'image/jpeg', byteSize: 1200, frameTimeMs: 450};
const enrollment: SurfaceRecord = {id: 'enrollment-a', proofId: 'proof-a', packageInstanceId: 'package-a', shipmentLegId: 'outbound', createdAt: '2026-10-01T12:00:00Z', sha256: 'b'.repeat(64), sourceDigests: [source], regionMap: [{id: 'region-a', sourceId: source.sourceId, group: 'print', polygon: [[0,0],[1,0],[1,1],[0,1]]}], captureProfileId: 'research-paper-v1', contextStage: 'unknown', captureMode: 'live', assurance: 'UNVERIFIED', state: 'analysis_pending'};
const observation = {...enrollment, id: 'observation-a', enrollmentId: enrollment.id, contextStage: 'before_opening'};
const summary: SurfaceSummary = {schemaVersion: 'surface-api/1', experimental: true, capabilities: {collection: true, extraction: true, internalComparison: true, customerFindings: false, profileId: 'research-paper-v1', qualified: false}, enrollments: [enrollment], observations: [observation], comparisons: []};
function transport(value = summary) {
  return {read: vi.fn<SurfaceTransport['read']>().mockResolvedValue(value), compare: vi.fn<SurfaceTransport['compare']>().mockResolvedValue({id: 'comparison-a', enrollmentId: enrollment.id, observationId: observation.id, requestedScope: 'assembly', status: 'requested', createdAt: '2026-10-01', result: null}), export: vi.fn<SurfaceTransport['export']>().mockResolvedValue(), saveSource: vi.fn<SurfaceTransport['saveSource']>().mockResolvedValue(), source: vi.fn<SurfaceTransport['source']>().mockResolvedValue({url: 'blob:original'})};
}
async function open(client: SurfaceTransport) { render(<SurfaceFingerprintPanel proofId="proof-a" enabled transport={client}/>); fireEvent.click(screen.getByRole('button', {name: 'Open research review'})); await screen.findByRole('button', {name: 'Request research comparison'}); }

describe('surface research reviewer safety', () => {
  it('keeps review off by default and does not unlock it in a production-mode build', () => {
    vi.stubEnv('VITE_PACKPROOF_RESEARCH_BUILD', 'true'); vi.stubEnv('VITE_SURFACE_FINGERPRINT_REVIEW', 'true'); vi.stubEnv('MODE', 'rnd');
    render(<ResearchBuildBanner/>); const toggle = screen.getByRole('checkbox', {name: 'Enable surface research panels'}); expect(toggle).not.toBeChecked(); fireEvent.click(toggle); expect(sessionStorage.getItem('packproof.rnd.surface-review')).toBe('true');
    vi.stubEnv('MODE', 'production'); expect(surfaceReviewEnabled()).toBe(false);
  });
  it('does not render or contact the server when feature-off, or read before reviewer opt-in', async () => {
    const client = transport(); const view = render(<SurfaceFingerprintPanel proofId="proof-a" enabled={false} transport={client}/>);
    expect(view.container).toBeEmptyDOMElement(); expect(client.read).not.toHaveBeenCalled();
    view.rerender(<SurfaceFingerprintPanel proofId="proof-a" enabled transport={client}/>);
    expect(screen.getByText('Surface fingerprint research')).toBeVisible(); expect(client.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Open research review'})); await waitFor(() => expect(client.read).toHaveBeenCalledTimes(1));
  });
  it('shows webcam limits, committed originals, acquisition assurance, and region mapping', async () => {
    const client = transport(); await open(client);
    expect(screen.getByText(/Browser cameras are unqualified/)).toBeVisible();
    expect(screen.getAllByText(/not sensor certification/)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', {name: 'Review original'})[0]);
    expect(await screen.findByRole('img')).toHaveAttribute('src', 'blob:original');
    expect(client.source).toHaveBeenCalledWith('proof-a', source);
    fireEvent.click(screen.getByRole('button', {name: 'Save selected original'})); await waitFor(() => expect(client.saveSource).toHaveBeenCalledWith('proof-a', source));
    fireEvent.click(screen.getByRole('button', {name: 'Export R&D record'})); await waitFor(() => expect(client.export).toHaveBeenCalledWith('proof-a'));
  });
  it('offers only observations bound to the selected enrollment/package/leg', async () => {
    const client = transport({...summary, observations: [observation, {...observation, id: 'wrong-package', packageInstanceId: 'another-package'}, {...observation, id: 'wrong-leg', shipmentLegId: 'return'}, {...observation, id: 'wrong-enrollment', enrollmentId: 'another-enrollment'}]});
    await open(client); fireEvent.change(screen.getByLabelText('Enrollment'), {target: {value: enrollment.id}});
    const options = (screen.getByLabelText('Later observation') as HTMLSelectElement).options;
    expect(Array.from(options, option => option.value)).toEqual(['', observation.id]);
  });
  it('sends committed references only and retains one idempotency key across transport failures', async () => {
    const client = transport(); client.compare.mockRejectedValueOnce(new Error('Network unavailable')); await open(client);
    fireEvent.change(screen.getByLabelText('Enrollment'), {target: {value: enrollment.id}}); fireEvent.change(screen.getByLabelText('Later observation'), {target: {value: observation.id}});
    fireEvent.click(screen.getByRole('button', {name: 'Request research comparison'})); await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', {name: 'Request research comparison'})); await waitFor(() => expect(client.compare).toHaveBeenCalledTimes(2));
    const first = client.compare.mock.calls[0]; expect(first[0]).toBe('proof-a'); expect(first[1]).toEqual({enrollmentId: enrollment.id, observationId: observation.id, requestedScope: 'assembly', idempotencyKey: expect.any(String)});
    expect(client.compare.mock.calls[1][1].idempotencyKey).toBe(first[1].idempotencyKey);
  });
  it('keeps label, carton and assembly separate and suppresses qualified states in R&D', async () => {
    const client = transport({...summary, comparisons: [{id: 'analysis-a', enrollmentId: enrollment.id, observationId: observation.id, requestedScope: 'assembly', status: 'consistent', createdAt: '2026-10-01', result: {qualification: 'qualified', scopeResults: {label: {status: 'consistent', reasons: []}, carton: {status: 'difference_observed', reasons: ['required_region_missing']}, assembly: {status: 'inconclusive', reasons: []}}, coverage: {required: 4, observed: 1}, method: {extractorVersion: 'research-v1'}, sourceDigests: [source], limitations: ['Not qualified']}}]});
    await open(client); expect(screen.getByRole('heading', {name: 'Label surface'})).toBeVisible(); expect(screen.getByRole('heading', {name: 'Carton surface'})).toBeVisible(); expect(screen.getByRole('heading', {name: 'Label + carton relationship'})).toBeVisible();
    expect(screen.queryByText('Consistent', {exact: true})).toBeNull(); expect(screen.queryByText('Difference observed', {exact: true})).toBeNull(); expect(screen.getByText('required region missing')).toBeVisible(); expect(screen.getByText('research-v1')).toBeInTheDocument();
  });
  it('retains readable records with backend analysis disabled and distinguishes operational error', async () => {
    const client = transport({...summary, capabilities: {...summary.capabilities, internalComparison: false}}); await open(client);
    fireEvent.change(screen.getByLabelText('Enrollment'), {target: {value: enrollment.id}}); fireEvent.change(screen.getByLabelText('Later observation'), {target: {value: observation.id}});
    expect(screen.getByRole('button', {name: 'Request research comparison'})).toBeDisabled(); expect(screen.getByRole('button', {name: 'Export R&D record'})).toBeEnabled();
    expect(researchStatus('error')).toMatch(/Analysis unavailable/); expect(researchStatus('consistent')).not.toBe('Consistent');
  });
  it('discards an in-flight response when the reviewer changes Proof', async () => {
    let resolve!: (value: SurfaceSummary) => void; const client = transport(); client.read.mockImplementationOnce(() => new Promise(done => {resolve = done;}));
    const view = render(<SurfaceFingerprintPanel proofId="proof-a" enabled transport={client}/>); fireEvent.click(screen.getByRole('button', {name: 'Open research review'}));
    view.rerender(<SurfaceFingerprintPanel proofId="proof-b" enabled transport={client}/>); resolve(summary);
    await waitFor(() => expect(screen.getByRole('button', {name: 'Open research review'})).toBeVisible()); expect(screen.queryByText('Committed sources')).toBeNull();
  });
  it('canonicalizes the exact command and strips client-authored scores or source substitutions', () => {
    const input = {enrollmentId: 'e', observationId: 'o', requestedScope: 'label' as const, idempotencyKey: 'key', score: 1, sourceDigests: ['forged']};
    expect(surfaceCanonicalJson(surfaceCommand(input))).toBe('{"enrollmentId":"e","observationId":"o","requestedScope":"label","schemaVersion":"surface-command/1"}');
  });
});
