/** Synthetic component fixture, bundled only by the visual QA runner. */
import { createRoot } from 'react-dom/client';
import type { PackProofApi } from '../../src/api/client';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { SourceBackfills, type SourceBackfill } from '../../src/records/SourceBackfills';
import { SourceCompletenessPolicy } from '../../src/records/SourceCompletenessPolicy';
import type { SourceConfig, SourceSubscription } from '../../src/records/SourceSubscriptions';
import '../../src/styles.css';
import '../../src/records/records.css';
import '../../src/records/agents.css';
import '../../src/records/operational-cases.css';

declare global { interface Window { __writes: Array<{ path: string; body: unknown }> } }
const headers = ['Order', 'Line', 'Quantity', 'Unit', 'Snapshot At', ' Export mArKer ', 'Export As Of', 'Export Data Rows'];
const source: SourceSubscription = {
  id: 'source-a', subscriptionId: 'source-a', configurationRevision: 2, grantRevision: 3, state: 'active',
  installationId: 'computer-a', connectionId: 'erp-a', locationId: 'site-a', operatorMembershipId: 'member-a',
  configurationSha256: 'c'.repeat(64), lastCheckAt: null, sourceAsOf: null, updatedAt: '2026-11-14T01:00:00Z', heartbeat: {},
  capabilities: { csvSnapshotBoundary: true, sourceBackfillJobs: true },
  config: {
    batchSchema: 'packproof.typed-source-batch/v2', transport: 'local_ntfs', displayName: 'Order snapshot export',
    sourceProfile: 'packproof.order-lines/v1', mappingVersion: 'orders/3', sourceNamespace: 'site-a-erp',
    mapping: { orderId: 'Order', orderLineId: 'Line', amount: 'Quantity', unit: 'Unit', sourceAsOf: 'Snapshot At' },
    constants: { observationKind: 'snapshot', property: 'orderedQuantity', timeQuality: 'snapshot_time_only' },
    identityPolicy: { schema: 'packproof.source-identity-policy/v1', eventKey: { kind: 'composite', fields: ['orderId', 'orderLineId', 'property'] }, revision: { kind: 'source_as_of' } },
    wholeFileConsent: true, folderDigest: 'a'.repeat(64), initialFileName: 'orders.csv', initialOriginalSha256: 'b'.repeat(64),
    expectedHeaders: headers, historyFrom: '2026-10-01T00:00:00Z', historyTo: null, maxBytes: 2097152, maxRows: 1000,
    offlineWindowHours: 24, expectedIntervalSeconds: 3600, unknownTimePolicy: 'quarantine',
    completenessPolicy: { kind: 'unknown', scope: 'shipment_line', sourceOwnerQualified: false, qualificationReference: null },
  },
};
const longName = 'order_snapshot_site_a_2026_10_31_final_with_shipment_allocation_and_original_export_control_columns.csv';
let job: SourceBackfill = {
  schema: 'packproof.source-backfill/v1', id: 'backfill-a', organizationId: 'org-a', environment: 'sandbox', principalId: 'principal-a',
  connectionId: source.connectionId, locationId: source.locationId, operatorMembershipId: source.operatorMembershipId,
  subscriptionId: source.id, installationId: source.installationId, configurationRevision: 2,
  configurationSha256: source.configurationSha256, grantRevision: 3, credentialId: 'synthetic-credential-a', manifestSha256: 'd'.repeat(64),
  historyFrom: '2026-10-01T00:00:00Z', historyTo: '2026-10-31T23:59:59Z', semantics: 'cumulative_snapshot', state: 'proposed',
  approvalExpiresAt: null, createdAt: '2026-11-14T01:00:00Z', decisions: [], blockReason: null,
  approvalPath: `/app/records/connect/approve?organizationId=org-a&environment=sandbox&installationId=computer-a&subscriptionId=source-a&configurationRevision=2&backfillJobId=backfill-a&manifestSha256=${'d'.repeat(64)}`,
  latestDecisionId: null, decisionLimit: 100, decisionsComplete: true,
  originals: [
    { id: 'original-a', name: 'orders-october.csv', mediaType: 'text/csv', sha256: 'e'.repeat(64), byteSize: 120, batchId: null, receiptState: null, counts: null },
    { id: 'original-b', name: longName, mediaType: 'text/csv', sha256: 'f'.repeat(64), byteSize: 2048, batchId: null, receiptState: null, counts: null },
  ],
  progress: {
    files: { total: 2, received: 0, pending: 2, processing: 0, succeeded: 0, failed: 0 },
    rows: { processing: 0, acceptedLinked: 0, acceptedUnlinked: 0, duplicate: 0, conflict: 0, quarantined: 0, rejected: 0 }, receivedRows: 0,
  },
  capabilities: { approve: true, pause: false, resume: false, collect: false },
};
window.__writes = [];
async function recordsRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  if (method === 'POST') {
    window.__writes.push({ path, body });
    const command = body as { action: string; expiresAt: string; reason: string; config: SourceConfig };
    if (path.startsWith('/source-backfills/')) {
      const decisionId = `synthetic-decision-${job.decisions.length + 1}`;
      job = { ...job, state: 'approved', approvalExpiresAt: command.expiresAt, latestDecisionId: decisionId,
        decisions: [...job.decisions, { id: decisionId, action: command.action, wholeFileConsent: true, expiresAt: command.expiresAt,
          reason: command.reason, actorUserId: 'synthetic-admin', actorMembershipId: 'synthetic-member', createdAt: new Date().toISOString(), supersedesId: job.latestDecisionId }],
        capabilities: { approve: false, pause: true, resume: false, collect: true } };
      return job as T;
    }
    if (path.startsWith('/source-subscriptions/')) return { ...source, state: 'proposed', config: command.config,
      configurationRevision: 3, grantRevision: 4, configurationSha256: '9'.repeat(64) } as T;
  }
  if (method === 'GET' && path.startsWith('/source-backfills/')) return job as T;
  if (method === 'GET' && path.startsWith('/source-subscriptions/')) return { schema: 'packproof.source-backfills/v1', jobs: [job], nextCursor: null } as T;
  throw new Error('The synthetic fixture has no live API or network transport.');
}
const api = { recordsRequest } as PackProofApi;
const scenario = new URLSearchParams(location.search).get('scenario') === 'completeness' ? 'completeness' : 'backfill';
createRoot(document.getElementById('root')!).render(<ThemeProvider>
  <div className="records-shell">
    <aside className="records-sidebar"><div className="records-brand"><span>PackProof</span></div><nav>
      <a href="?scenario=backfill" aria-current={scenario === 'backfill' ? 'page' : undefined}>Historical import</a>
      <a href="?scenario=completeness" aria-current={scenario === 'completeness' ? 'page' : undefined}>Snapshot controls</a>
    </nav></aside>
    <div className="records-workspace"><header className="records-topbar"><strong>Synthetic component QA — no live data</strong></header>
      <main className="records-main"><header className="records-page-heading"><div><span className="records-eyebrow">SYNTHETIC SOURCE REVIEW</span>
        <h1>Order snapshot export</h1><p>Actual review components and production styles. This test does not establish hosted or installed Windows acceptance.</p>
      </div></header><section className="records-panel source-subscription-approval">
        {scenario === 'backfill' ? <SourceBackfills api={api} source={source} organizationId="org-a" environment="sandbox" requestedJobId={job.id} requestedManifest={job.manifestSha256}/>
          : <SourceCompletenessPolicy api={api} source={source} organizationId="org-a" environment="sandbox" onSaved={() => {}}/>}
      </section></main>
    </div>
  </div>
</ThemeProvider>);
