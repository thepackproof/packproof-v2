import { afterEach, describe, expect, it } from 'vitest';
import { NodeClient, createTransport, getCurrentScope, getGlobalScope, getIsolationScope, startSession } from '@sentry/node';
import { ErrorReporting } from '../src/main/error-reporting.js';

const dsn = 'https://0123456789abcdef0123456789abcdef@o123.ingest.us.sentry.io/123';
const scopes = () => [...new Set([getGlobalScope(), getCurrentScope(), getIsolationScope()])];

afterEach(() => {
  for (const scope of scopes()) {
    scope.clearAttachments();
    scope.clearBreadcrumbs();
    scope.setUser({});
    scope.setContext('privateFixture', null);
    scope.setExtra('privateFixture', undefined);
    scope.setTag('privateFixture', undefined);
    scope.setSession(undefined);
  }
});

/** Uses Sentry's real envelope serializer, replacing only the HTTP request executor. */
function wireHarness() {
  const bodies: string[] = [];
  let client!: NodeClient;
  const reporter = new ErrorReporting({
    dsn, channel: 'staging', version: '1.0.0', platform: 'darwin',
    transportFactory: options => {
      const transport = createTransport(options, async request => {
        bodies.push(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString('utf8'));
        return { statusCode: 200 };
      });
      return transport;
    },
    clientFactory: options => { client = new NodeClient(options); return client; },
  });
  return { reporter, client, bodies };
}

function expectOnlyCodedReport(bodies: string[]) {
  expect(bodies).toHaveLength(1);
  const lines = bodies[0].split('\n');
  expect(lines).toHaveLength(3);
  const [header, item, event] = lines.map(line => JSON.parse(line));
  expect(Object.keys(header).sort()).toEqual(['event_id', 'sent_at']);
  expect(header.event_id).toMatch(/^[a-f0-9]{32}$/i);
  expect(new Date(header.sent_at).toISOString()).toBe(header.sent_at);
  expect(item).toEqual({ type: 'event' });
  expect(event).toEqual({
    event_id: header.event_id,
    level: 'error', message: 'PackProof Desktop SYSTEM/IPC_FAILURE',
    release: 'packproof-desktop@1.0.0', environment: 'staging', platform: 'node',
    tags: { category: 'SYSTEM', code: 'IPC_FAILURE', os: 'darwin' },
    fingerprint: ['packproof-desktop', 'SYSTEM', 'IPC_FAILURE'],
  });
  expect(bodies.join('')).not.toMatch(/PRIVATE_FIXTURE|attachment|session|breadcrumbs|exception|contexts|request|server_name|email|filename|sentry_key|0123456789abcdef/);
}

describe('desktop reporting final transport privacy boundary', () => {
  it('serializes only one coded event despite global, current and isolation scope data and attachments', async () => {
    const session = startSession({ release: 'PRIVATE_FIXTURE_RELEASE', user: { id: 'PRIVATE_FIXTURE_USER', email: 'PRIVATE_FIXTURE_EMAIL' } });
    for (const [index, scope] of scopes().entries()) {
      scope.setUser({ id: `PRIVATE_FIXTURE_USER_${index}`, email: 'PRIVATE_FIXTURE_EMAIL' });
      scope.setContext('privateFixture', { evidencePath: 'PRIVATE_FIXTURE_PATH' });
      scope.setExtra('privateFixture', 'PRIVATE_FIXTURE_EXTRA');
      scope.setTag('privateFixture', 'PRIVATE_FIXTURE_TAG');
      scope.addBreadcrumb({ message: 'PRIVATE_FIXTURE_BREADCRUMB' });
      scope.addAttachment({ filename: `PRIVATE_FIXTURE_ATTACHMENT_${index}.txt`, data: 'PRIVATE_FIXTURE_MEDIA' });
      scope.setSession(session);
    }
    const { reporter, bodies } = wireHarness();
    reporter.record('SYSTEM', 'IPC_FAILURE');
    await reporter.close();
    expectOnlyCodedReport(bodies);
  });

  it('rebuilds the final envelope after SDK hooks can add metadata or extra items', async () => {
    const { reporter, client, bodies } = wireHarness();
    client.on('beforeEnvelope', envelope => {
      envelope[0].trace = { public_key: 'PRIVATE_FIXTURE_KEY', trace_id: 'a'.repeat(32) };
      for (const item of envelope[1]) {
        if (item[0].type === 'event' && typeof item[1] === 'object' && item[1] !== null) {
          Object.assign(item[1], { user: { email: 'PRIVATE_FIXTURE_EMAIL' }, extra: { path: 'PRIVATE_FIXTURE_PATH' } });
        }
      }
      const items = envelope[1] as Array<[{ type: string; filename?: string }, unknown]>;
      items.push([{ type: 'attachment', filename: 'PRIVATE_FIXTURE_ATTACHMENT.txt' }, new TextEncoder().encode('PRIVATE_FIXTURE_MEDIA')]);
    });
    reporter.record('SYSTEM', 'IPC_FAILURE');
    await reporter.close();
    expectOnlyCodedReport(bodies);
  });

  it('never forwards SDK session reports or internal exceptions that bypass beforeSend', async () => {
    const { reporter, client, bodies } = wireHarness();
    const session = startSession({ release: 'PRIVATE_FIXTURE_RELEASE', user: { id: 'PRIVATE_FIXTURE_USER', email: 'PRIVATE_FIXTURE_EMAIL' } });
    client.captureSession(session);
    client.captureException(new Error('PRIVATE_FIXTURE_INTERNAL_ERROR'), { data: { __sentry__: true } });
    await reporter.close();
    expect(bodies).toEqual([]);
  });
});
