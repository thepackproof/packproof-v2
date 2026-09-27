import { describe, expect, it, vi } from 'vitest';
import { runReportingCanary, type ReportingCanaryInput } from '../src/main/reporting-canary.js';
import type { ReportingTransportFactory } from '../src/main/error-reporting.js';

const input: ReportingCanaryInput = {
  send: true, dsn: 'https://0123456789abcdef0123456789abcdef@o123.ingest.us.sentry.io/123',
  channel: 'staging', version: '1.0.0', sourceCommit: 'a'.repeat(40),
  approvedProjectId: '123', approvedIngestHost: 'o123.ingest.us.sentry.io',
};

describe('operator reporting canary', () => {
  it.each([
    { send: false }, { dsn: '' }, { dsn: input.dsn.replace('sentry.io', 'invalid.example') },
    { channel: 'development' }, { approvedProjectId: '456' }, { approvedIngestHost: 'o456.ingest.us.sentry.io' },
    { sourceCommit: 'not-a-commit' }, { version: 'customer-provided-value' },
  ])('rejects unapproved or incomplete inputs before creating a transport: %j', async patch => {
    const factory = vi.fn();
    await expect(runReportingCanary({ ...input, ...patch }, factory)).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it('sends one fixed filtered event and records acknowledgment without claiming delivery', async () => {
    const envelopes: unknown[] = [];
    const receipt = await runReportingCanary(input, () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }));
    expect(envelopes).toHaveLength(1);
    const serialized = JSON.stringify(envelopes);
    expect(serialized).toContain('PackProof Desktop SYSTEM/REPORTING_CANARY');
    expect(serialized).toContain(receipt.eventId!);
    expect(serialized).not.toMatch(/0123456789abcdef|dsn|server_name|attachment|request|exception|breadcrumbs/);
    expect(receipt).toMatchObject({ ingestAcknowledged: true, sdkFlushed: true, wireFilterPassed: true, deliveryVerified: false, transportAttempts: 1, httpStatus: 200, result: 'INGEST_ACKNOWLEDGED_READBACK_REQUIRED' });
    expect(receipt.eventId).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify(receipt)).not.toContain(input.dsn);
  });

  it.each([undefined, 400, 429, 500])('does not mistake a drained SDK queue for acknowledgment: %s', async statusCode => {
    const receipt = await runReportingCanary(input, () => ({ send: async () => ({ statusCode }), flush: async () => true }));
    expect(receipt).toMatchObject({ sdkFlushed: true, ingestAcknowledged: false, deliveryVerified: false, result: 'INGEST_NOT_CONFIRMED' });
  });

  it('reports an unconfirmed result for failed transport and drops raw exception content', async () => {
    const factory: ReportingTransportFactory = () => ({ send: async () => { throw new Error('FABRICATED_PRIVATE_TOKEN'); }, flush: async () => true });
    const receipt = await runReportingCanary(input, factory);
    expect(receipt.ingestAcknowledged).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('FABRICATED_PRIVATE_TOKEN');
  });

  it('does not acknowledge successful HTTP when flush is unconfirmed', async () => {
    const receipt = await runReportingCanary(input, () => ({ send: async () => ({ statusCode: 200 }), flush: async () => false }));
    expect(receipt).toMatchObject({ sdkFlushed: false, ingestAcknowledged: false, deliveryVerified: false });
  });
});
