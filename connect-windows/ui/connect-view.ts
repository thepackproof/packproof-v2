import { configKey, verificationCurrent } from './state';
import type { ConnectStatus, LocalAnalysis, TransportObservation } from './types';

const V2 = 'packproof.scheduled-csv/v2';
const REQUIRED = ['shipmentReference', 'itemTitle', 'quantity', 'shippedAt'];
export interface ConnectionProblem {
  kind: 'service' | 'permission' | 'network' | 'compatibility' | 'freshness' | 'source' | 'review';
  title: string;
  message: string;
  action: 'retry' | 'repair' | 'review' | 'update';
}
export interface ConnectPrerequisites {
  localReady: boolean;
  serviceReady: boolean;
  remoteCompatible: boolean;
  networkReachable: boolean;
  configApproved: boolean;
  originalUploaded: boolean;
  batchApproved: boolean;
  recordVerified: boolean;
  recurringApproved: boolean;
  serviceAcknowledged: boolean;
}
export type ProgressPhase = 'source_access' | 'first_import' | 'ongoing_collection' | 'connected';
interface ViewBase {
  title: string;
  hero: LocalAnalysis['shipment'] | undefined;
  cta: string;
  ctaDisabledReason?: string;
  problem?: ConnectionProblem;
  nextAction: string;
  progressPhase: ProgressPhase;
  recordLink?: { recordId: string };
  prerequisites: ConnectPrerequisites;
  phases: Array<{ id: ProgressPhase; label: string; state: 'complete' | 'current' | 'pending' }>;
}
export type ConnectView = ViewBase & (
  { stage: 'source' } | { stage: 'review' } | { stage: 'activation' } |
  { stage: 'home'; connectionState: 'Active' | 'Needs attention' | 'Paused' | 'Checking' | 'Offline' | 'Permission expired' }
);

/** Presentation only. All commands must still pass service and API authorization. */
export function deriveConnectView(
  status: ConnectStatus | null,
  analysis: LocalAnalysis | undefined = status?.analysis,
  transportObservation: TransportObservation | undefined = status?.transport,
  now: number = Date.now(),
): ConnectView {
  const source = status?.source;
  const localReady = !!analysis?.ready && !!analysis.shipment && !!source?.accessible
    && !!status?.installationId && analysis.binding.sourceBindingId === status.installationId
    && analysis.binding.fileSha256 === source.fileSha256 && analysis.binding.folderDigest === source.folderDigest
    && REQUIRED.every(field => analysis.decisions.some(d => d.field === field && d.state === 'validated'));
  const serviceReady = !!status?.health.serviceOnline && !status.error
    && !!status.checks?.length && status.checks.every(c => c.state === 'passed' || c.state === 'warning');
  const probe = transportObservation;
  const attempted = Date.parse(probe?.attemptedAt || '');
  const succeeded = Date.parse(probe?.succeededAt || '');
  const expires = Date.parse(probe?.expiresAt || '');
  // A persisted future timestamp or unbounded/expired observation is not evidence.
  const recent = Number.isFinite(now) && Number.isFinite(attempted) && Number.isFinite(expires)
    && attempted <= now && now < expires && expires - attempted <= 120_000;
  const reachableStates = ['compatible', 'unsupported', 'outdated', 'unauthenticated', 'forbidden'];
  const networkReachable = !!probe && recent && reachableStates.includes(probe.state);
  const expectedRules = analysis?.binding.rulesVersion ?? status?.config?.sourceContract?.rulesVersion;
  const legacySource = !analysis && status?.config?.sourceContract?.schema === 'packproof.scheduled-csv/v1';
  const successfulProbe = !!probe && recent && Number.isFinite(succeeded) && succeeded >= attempted && succeeded <= now;
  // Existing approved v1 sources retain their original semantics. New guided
  // setup always has a v2 analysis and must satisfy the exact semantic contract.
  const remoteCompatible = successfulProbe && (legacySource
    ? ['compatible', 'unsupported', 'outdated'].includes(probe!.state) && probe!.sourceContracts?.includes('packproof.scheduled-csv/v1') === true
    : probe!.state === 'compatible' && !!expectedRules && probe!.expectedRulesVersion === expectedRules
      && probe!.observedRulesVersion === expectedRules && probe!.sourceContracts?.includes(V2) === true);
  const configApproved = !!status?.config && !status.pendingProposal
    && (!analysis || configKey(analysis.configuration) === configKey(status.config));
  const originalUploaded = !!status?.preview && !!source?.fileSha256
    && status.preview.original.sha256 === source.fileSha256;
  const batchApproved = originalUploaded && ['queued', 'running', 'succeeded', 'partially_succeeded', 'failed'].includes(status!.preview!.state);
  const recordVerified = !!status && verificationCurrent(status, status.config, false);
  const recurringApproved = recordVerified && status?.state === 'active';
  const serviceAcknowledged = recurringApproved && !!status?.health.serviceOnline && !status?.setup?.running && !status.error && remoteCompatible && serviceReady && configApproved;
  const prerequisites: ConnectPrerequisites = { localReady, serviceReady, remoteCompatible, networkReachable, configApproved, originalUploaded, batchApproved, recordVerified, recurringApproved, serviceAcknowledged };

  let problem: ConnectionProblem | undefined;
  if (status && (!status.health.serviceOnline || status.error)) problem = { kind: 'service', title: 'The background helper needs attention.', message: status.error?.message || 'Check the installed helper before starting collection. Your pending work is preserved.', action: 'repair' };
  else if (status?.state === 'revoked' || probe?.state === 'unauthenticated' || probe?.state === 'forbidden') problem = { kind: 'permission', title: 'PackProof permission is required.', message: 'An authorized administrator must review this connection before collection can continue.', action: 'review' };
  else if (probe?.state === 'unreachable' && recent) problem = { kind: 'network', title: 'Cannot reach PackProof right now', message: 'Your local review is saved. Retry the connection before requesting the next permission.', action: 'retry' };
  else if (!remoteCompatible && recent && (probe?.state === 'unsupported' || probe?.state === 'outdated' || probe?.state === 'compatible' && !remoteCompatible)) problem = { kind: 'compatibility', title: 'An update is required to connect safely', message: 'Your preview is saved locally. The PackProof service and this installation need matching source-validation support.', action: 'update' };
  else if (status?.installationId && !remoteCompatible) problem = { kind: 'freshness', title: 'Check the connection before continuing', message: 'A fresh PackProof compatibility check is required. Your local review remains available.', action: 'retry' };
  else if (analysis && !localReady && !status?.setup?.running && !status?.preview) problem = { kind: 'source', title: 'This report needs attention', message: 'Review the unresolved shipment details or choose a different report.', action: 'review' };
  else if (status?.setup?.phase === 'needs_review' || status?.setup?.phase === 'needs_retry' || status?.state === 'needs_review') problem = { kind: 'review', title: 'First import requires attention', message: 'Review the source and durable import outcome before trying again. Preserved work will not be removed.', action: 'review' };

  const progressPhase: ProgressPhase = serviceAcknowledged ? 'connected' : recordVerified ? 'ongoing_collection' : configApproved || originalUploaded ? 'first_import' : 'source_access';
  const phaseIndex = ['source_access', 'first_import', 'ongoing_collection', 'connected'].indexOf(progressPhase);
  const phases = [
    { id: 'source_access' as const, label: 'Review source access' },
    { id: 'first_import' as const, label: 'Check the first import' },
    { id: 'ongoing_collection' as const, label: 'Enable ongoing collection' },
  ].map((phase, i) => ({ ...phase, state: (i < phaseIndex ? 'complete' : i === phaseIndex ? 'current' : 'pending') as 'complete' | 'current' | 'pending' }));
  const ctaDisabledReason = !serviceReady ? 'Verify the background helper before continuing.'
    : !localReady && !status?.setup?.running && !status?.preview ? 'Review the required shipment details first.'
    : !remoteCompatible ? problem?.message || 'Check current server compatibility first.'
    : status?.state === 'revoked' ? 'Administrator approval is required.' : undefined;
  const base: ViewBase = { title: 'Where does your warehouse save shipment reports?', hero: analysis?.shipment,
    cta: 'Review permissions in browser', ctaDisabledReason, problem,
    nextAction: problem?.message || (serviceAcknowledged ? 'Open your verified shipment records.' : recordVerified ? 'Review ongoing collection in your browser.' : originalUploaded ? 'Complete the exact batch review in your browser.' : 'Review source permissions in your browser.'),
    progressPhase, prerequisites, phases,
    recordLink: recordVerified && status?.verification?.recordId ? { recordId: status.verification.recordId } : undefined };
  // Once a source has a canonical record, keep its home visible through pause/offline/revocation.
  const hasPreviousRecord = !!status?.verification?.recordId && !!status.config
    && ['revoked', 'action_needed', 'needs_review'].includes(status.state);
  if (!status?.setup?.running && (hasPreviousRecord || status?.state === 'paused' || status?.state === 'active')) {
    const connectionState = status?.state === 'revoked' || probe?.state === 'unauthenticated' || probe?.state === 'forbidden' ? 'Permission expired'
      : status?.state === 'paused' ? 'Paused' : !status?.health.serviceOnline || problem?.kind === 'network' ? 'Offline'
      : serviceAcknowledged ? 'Active' : problem && problem.kind !== 'freshness' ? 'Needs attention' : 'Checking';
    return { ...base, stage: 'home', title: serviceAcknowledged ? 'Your shipments are connected' : 'Your source overview', connectionState };
  }
  if (recordVerified || status?.setup?.running || status?.pendingProposal || status?.preview) return { ...base, stage: 'activation', title: 'Ready to connect your shipments?' };
  if (analysis && source?.accessible) return { ...base, stage: 'review', title: 'We found your shipments.', cta: 'Yes, this looks right' };
  return { ...base, stage: 'source', cta: status?.installationId ? 'Choose shipment folder' : 'Sign in and approve this computer' };
}
