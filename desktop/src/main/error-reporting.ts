import { NodeClient, Scope, makeNodeTransport, type Event, type ErrorEvent } from '@sentry/node';
import type { ReleaseChannel } from './config.js';

/** The only data categories allowed into centralized desktop diagnostics. */
export const REPORT_CODES = {
  AUTH: ['AUTH_FAILURE', 'SESSION_REFRESH_FAILED', 'SECURE_STORAGE_FAILURE'],
  CAPTURE: ['CAMERA_PERMISSION_DENIED', 'CAMERA_DISCONNECTED', 'CAMERA_UNAVAILABLE', 'RECORDING_FAILED', 'CAPTURE_INTERRUPTED', 'STAGING_FAILED', 'DISK_WRITE_FAILED'],
  UPLOAD: ['UPLOAD_FAILED', 'UPLOAD_RETRY_EXHAUSTED', 'UPLOAD_NETWORK_FAILURE', 'UPLOAD_AUTH_REQUIRED', 'EVIDENCE_DIGEST_MISMATCH', 'COMMIT_UNCONFIRMED', 'FINALIZATION_FAILED'],
  UPDATES: ['UPDATE_CHECK_FAILED', 'UPDATE_DOWNLOAD_FAILED', 'UPDATE_INSTALL_FAILED', 'UPDATE_SIGNATURE_INVALID'],
  SYSTEM: ['IPC_FAILURE', 'RENDERER_CRASH', 'UNCAUGHT_EXCEPTION', 'UNHANDLED_REJECTION', 'SERVICE_CONFIG_MISSING', 'SECURE_STORAGE_OR_QUEUE_UNAVAILABLE', 'REPORTING_CANARY'],
} as const;
export type ReportCategory = keyof typeof REPORT_CODES;
export type ErrorReportingState = { configured: boolean; enabled: boolean; provider: 'sentry'; reason?: 'NOT_CONFIGURED' | 'INVALID_DSN' | 'DISABLED_IN_DEVELOPMENT' | 'INITIALIZATION_FAILED' };
type ReporterClient = Pick<NodeClient, 'captureEvent' | 'close'>;
export type ErrorReportingClientOptions = ConstructorParameters<typeof NodeClient>[0];
export type ReportingTransportFactory = typeof makeNodeTransport;

/** Rebuild the wire envelope too: SDK hints may add attachments after beforeSend. */
function privateTransport(transport: ReturnType<ReportingTransportFactory>, release: string, environment: ReleaseChannel, platform: string): ReturnType<ReportingTransportFactory> {
  return {
    send(envelope) {
      const events = envelope[1].filter(item => item[0].type === 'event');
      if (events.length !== 1) return Promise.resolve({});
      const payload = events[0][1];
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return Promise.resolve({});
      const event = scrubReport(payload as Event, release, environment, platform);
      if (!event?.event_id) return Promise.resolve({});
      // No original headers, attachments, sessions, trace context or internal SDK errors cross this boundary.
      return transport.send([{ event_id: event.event_id, sent_at: new Date().toISOString() }, [[{ type: 'event' }, event]]]);
    },
    flush(timeout) { return transport.flush(timeout); },
  };
}

function knownCode(category: unknown, code: unknown): category is ReportCategory {
  return typeof category === 'string' && Object.hasOwn(REPORT_CODES, category) && typeof code === 'string' && (REPORT_CODES[category as ReportCategory] as readonly string[]).includes(code);
}
/** Hosted public DSNs only; never accept DSN passwords, arbitrary collectors or cleartext transport. */
export function validPublicDsn(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.password && !url.port && !url.search && !url.hash
      && /^[a-f0-9]{32}$/i.test(url.username) && /^\/\d+$/.test(url.pathname)
      && (url.hostname === 'sentry.io' || /^[a-z0-9-]+\.ingest(?:\.[a-z]{2})?\.sentry\.io$/.test(url.hostname));
  } catch { return false; }
}

/** Rebuild from an allowlist after SDK processing so global scopes can never add customer data. */
export function scrubReport(event: Event, release: string, environment: ReleaseChannel, platform: string): ErrorEvent | null {
  const category = event.tags?.category; const code = event.tags?.code;
  if (!knownCode(category, code)) return null;
  const safePlatform = ['win32', 'darwin', 'linux'].includes(platform) ? platform : 'unknown';
  return {
    type: undefined,
    ...(event.event_id && /^[a-f0-9]{32}$/i.test(event.event_id) ? { event_id: event.event_id } : {}),
    level: 'error', message: `PackProof Desktop ${category}/${String(code)}`,
    release, environment, platform: 'node',
    tags: { category, code: String(code), os: safePlatform },
    fingerprint: ['packproof-desktop', category, String(code)],
  };
}

/** No automatic instrumentation, exception capture, files, sessions, replay, requests, identities or media. */
export class ErrorReporting {
  readonly state: ErrorReportingState;
  private readonly client: ReporterClient | null;
  private readonly scope = new Scope();
  private readonly recent = new Map<string, number>();
  constructor(input: { dsn?: string; version: string; channel: ReleaseChannel; platform?: string; clientFactory?: (options: ErrorReportingClientOptions) => ReporterClient; transportFactory?: ReportingTransportFactory; now?: () => number }) {
    this.input = input;
    this.client = null;
    if (!input.dsn) { this.state = { configured: false, enabled: false, provider: 'sentry', reason: 'NOT_CONFIGURED' }; return; }
    if (!validPublicDsn(input.dsn)) { this.state = { configured: false, enabled: false, provider: 'sentry', reason: 'INVALID_DSN' }; return; }
    if (['development', 'research'].includes(input.channel)) { this.state = { configured: true, enabled: false, provider: 'sentry', reason: 'DISABLED_IN_DEVELOPMENT' }; return; }
    const version = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(input.version) ? input.version : 'unknown';
    const release = `packproof-desktop@${version}`;
    try {
      this.client = (input.clientFactory ?? (options => new NodeClient(options)))({
        dsn: input.dsn, release, environment: input.channel,
        integrations: [], transport: options => privateTransport((input.transportFactory ?? makeNodeTransport)(options), release, input.channel, input.platform ?? process.platform), stackParser: () => [],
        attachStacktrace: false, includeLocalVariables: false, includeServerName: false,
        enableOpenTelemetrySetup: false, enableRuntimeChannelInjection: false,
        traceLifecycle: 'static', tracePropagationTargets: [], maxBreadcrumbs: 0,
        sendClientReports: false, debug: false,
        dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, databaseQueryData: false, queues: false, stackFrameVariables: false, frameContextLines: 0 },
        beforeBreadcrumb: () => null, beforeSendLog: () => null, beforeSendMetric: () => null,
        beforeSendTransaction: () => null,
        beforeSend: event => scrubReport(event, release, input.channel, input.platform ?? process.platform),
      });
      // Do not call global Sentry.init() or install global integrations.
      this.state = { configured: true, enabled: true, provider: 'sentry' };
    } catch { this.state = { configured: true, enabled: false, provider: 'sentry', reason: 'INITIALIZATION_FAILED' }; }
  }
  private readonly input: { now?: () => number };
  record(category: string, code: string): void {
    if (!this.client || !knownCode(category, code)) return;
    const key = `${category}/${code}`; const now = (this.input.now ?? Date.now)();
    if (this.recent.has(key) && now - this.recent.get(key)! < 60_000) return;
    this.recent.set(key, now);
    // Static message and codes only. No error object, stack, URL, account or evidence ID is accepted.
    // A private current scope avoids ambient sessions; the final transport boundary also excludes global/isolation scope data.
    try { this.client.captureEvent({ level: 'error', message: key, tags: { category, code } }, undefined, this.scope); } catch { /* Reporting must never interrupt preservation. */ }
  }
  async close(): Promise<void> { try { await this.client?.close(1500); } catch { /* Shutdown must not wait on diagnostics. */ } }
}
