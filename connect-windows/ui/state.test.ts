import { describe, expect, it } from 'vitest';
import { configKey, previewValid, resumeStep, suggestMapping, verificationCurrent } from './state';
import type { Configuration, ConnectStatus } from './types';
const config: Configuration = { sourceName: 'Dispatch', folderDigest: 'f'.repeat(64), integrationAccountId: 'source-a', operatorMembershipId: 'member-a', locationId: 'site-a', mapping: { shipmentReference: 'Reference', itemTitle: 'Description', quantity: 'Quantity' }, timeZone: 'America/New_York', importValidRows: false, offlineWindowHours: 24 };
const status: ConnectStatus = { state: 'ready', environment: 'sandbox', installationId: 'install-a', configRevision: 3, config, source: { folder: 'approved folder', folderDigest: config.folderDigest, accessible: true, fileSha256: 'file-a' }, verification: { complete: true, recordId: 'proof-a', configRevision: 3, fileSha256: 'file-a' }, health: { serviceOnline: true, queueCount: 0 } };
describe('setup trust boundaries', () => {
  it('does not reuse verification after any authority or mapping input changes', () => {
    expect(verificationCurrent(status, config, false)).toBe(true);
    for (const change of [{ sourceName: 'Other' }, { folderDigest: 'other' }, { timeZone: 'UTC' }, { integrationAccountId: 'source-b' }, { operatorMembershipId: 'member-b' }, { locationId: 'site-b' }, { importValidRows: true }, { offlineWindowHours: 0 }, { mapping: { ...config.mapping, quantity: 'Cases' } }]) expect(verificationCurrent(status, { ...config, ...change }, false)).toBe(false);
    expect(verificationCurrent(status, config, true)).toBe(false);
    expect(verificationCurrent({ ...status, state: 'revoked' }, config, false)).toBe(false);
    expect(verificationCurrent({ ...status, verification: { complete: true, recordId: 'proof-a' } }, config, false)).toBe(false);
    expect(verificationCurrent({ ...status, pendingProposal: config }, config, false)).toBe(false);
    expect(verificationCurrent({ ...status, configRevision: 4 }, config, false)).toBe(false);
    expect(verificationCurrent({ ...status, source: { ...status.source!, fileSha256: 'file-b' } }, config, false)).toBe(false);
  });
  it('requires a retrieved canonical record and preserves mapping identity regardless key order', () => {
    expect(verificationCurrent({ ...status, verification: { complete: true } }, config, false)).toBe(false);
    expect(configKey({ ...config, mapping: { quantity: 'Quantity', itemTitle: 'Description', shipmentReference: 'Reference' } })).toBe(configKey(config));
  });
  it('does not infer ambiguous identifiers or promote upload acceptance to verification', () => {
    expect(suggestMapping(['Shipment date'])).toEqual({ shippedAt: 'Shipment date' });
    expect(suggestMapping(['Order ID', 'Order number', 'Description', 'Qty'])).toEqual({ itemTitle: 'Description', quantity: 'Qty' });
    expect(verificationCurrent({ ...status, verification: undefined }, config, false)).toBe(false);
  });
  it('holds any invalid or ambiguous preview for first setup', () => {
    const preview = { id: 'import-a', previewVersion: 'v', state: 'previewed', original: { sha256: 'digest', byteSize: 10 }, rows: [], recordIds: [], counts: { valid: 1, invalid: 0, ambiguous: 0, failed: 0 } };
    expect(previewValid({ ...status, preview })).toBe(true);
    expect(previewValid({ ...status, preview: { ...preview, counts: { ...preview.counts, invalid: 1 } } })).toBe(false);
    expect(resumeStep({ ...status, preview })).toBe(5);
  });
});
