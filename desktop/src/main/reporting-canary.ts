import { NodeClient, makeNodeTransport } from '@sentry/node';
import { randomUUID } from 'node:crypto';
import { ErrorReporting, validPublicDsn, type ReportingTransportFactory } from './error-reporting.js';

export interface ReportingCanaryInput {
  send: boolean;
  dsn: string;
  channel: string;
  version: string;
  sourceCommit: string;
  approvedProjectId: string;
  approvedIngestHost: string;
}

export async function runReportingCanary(input: ReportingCanaryInput, transportFactory: ReportingTransportFactory = options => makeNodeTransport({ ...options, keepAlive: false })) {
  if (input.send !== true) throw new Error('EXPLICIT_SEND_REQUIRED');
  if (!validPublicDsn(input.dsn)) throw new Error('VALID_PUBLIC_DSN_REQUIRED');
  if (input.channel !== 'staging' && input.channel !== 'production') throw new Error('RELEASE_CHANNEL_REQUIRED');
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(input.version)) throw new Error('VALID_RELEASE_VERSION_REQUIRED');
  if (!/^[a-f0-9]{40}$/.test(input.sourceCommit)) throw new Error('EXACT_SOURCE_COMMIT_REQUIRED');
  const destination = new URL(input.dsn);
  if (!/^\d+$/.test(input.approvedProjectId) || destination.pathname !== `/${input.approvedProjectId}` || destination.hostname !== input.approvedIngestHost) throw new Error('APPROVED_PROJECT_MISMATCH');
  const startedAt = new Date().toISOString();
  let eventId: string | undefined;
  let wireEventId: string | undefined;
  let flushed = false;
  let attempts = 0;
  let statusCode: number | undefined;
  let transportFailed = false;
  let wireFilterPassed = false;
  const reporter = new ErrorReporting({
    dsn: input.dsn, version: input.version, channel: input.channel,
    clientFactory(options) {
      const client = new NodeClient(options);
      return {
        captureEvent(event, hint, scope) { eventId = randomUUID().replaceAll('-', ''); return client.captureEvent({ ...event, event_id: eventId }, { ...hint, event_id: eventId }, scope); },
        async close(timeout) { flushed = await client.close(timeout); return flushed; },
      };
    },
    transportFactory(options) {
      const transport = transportFactory(options);
      return {
        async send(envelope) {
          attempts++;
          const item = envelope[1][0];
          const event = item?.[1] as { event_id?: string; tags?: { category?: string; code?: string } } | undefined;
          wireEventId = event?.event_id;
          wireFilterPassed = envelope[1].length === 1 && item?.[0].type === 'event'
            && event?.tags?.category === 'SYSTEM' && event.tags.code === 'REPORTING_CANARY'
            && wireEventId === eventId && Object.keys(envelope[0]).sort().join(',') === 'event_id,sent_at';
          if (!wireFilterPassed || attempts !== 1) { transportFailed = true; return {}; }
          try {
            const response = await transport.send(envelope);
            statusCode = Number.isInteger(response.statusCode) && response.statusCode! >= 100 && response.statusCode! <= 599 ? response.statusCode : undefined;
            return response;
          } catch { transportFailed = true; return {}; }
        },
        flush(timeout) { return transport.flush(timeout); },
      };
    },
  });
  if (!reporter.state.enabled) throw new Error('REPORTER_INITIALIZATION_FAILED');
  reporter.record('SYSTEM', 'REPORTING_CANARY');
  await reporter.close();
  const ingestAcknowledged = attempts === 1 && wireFilterPassed && flushed && !transportFailed && statusCode !== undefined && statusCode >= 200 && statusCode < 300;
  return {
    schemaVersion: 1, startedAt, completedAt: new Date().toISOString(),
    sourceCommit: input.sourceCommit, release: `packproof-desktop@${input.version}`, environment: input.channel,
    destination: { provider: 'sentry', ingestHost: input.approvedIngestHost, projectId: input.approvedProjectId },
    eventId: eventId && /^[a-f0-9]{32}$/.test(eventId) ? eventId : null,
    category: 'SYSTEM', code: 'REPORTING_CANARY', transportAttempts: attempts,
    httpStatus: statusCode ?? null, sdkFlushed: flushed, wireFilterPassed, ingestAcknowledged,
    deliveryVerified: false,
    result: ingestAcknowledged ? 'INGEST_ACKNOWLEDGED_READBACK_REQUIRED' : 'INGEST_NOT_CONFIRMED',
    readbackRequired: 'An authorized operator must locate this event ID in the approved Sentry project and inspect its complete fields before recording delivery acceptance.',
  };
}
