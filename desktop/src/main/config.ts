export type ReleaseChannel = 'development' | 'staging' | 'production';
export interface DesktopConfig {
  channel: ReleaseChannel;
  research?: boolean;
  apiBaseUrl: string;
  webBaseUrl: string;
  cognito: { region: string; clientId: string; userPoolId: string };
  updateUrl?: string;
  /** Public Sentry ingest DSN; absent means no centralized error reports. */
  sentryDsn?: string;
}

/** Public build configuration only. Never put AWS credentials or client secrets here. */
export function loadConfig(env: Record<string, string | undefined> = process.env): DesktopConfig {
  const channel = env.APP_ENV ?? 'development';
  if (!['development', 'staging', 'production'].includes(channel)) throw new Error('Invalid desktop release channel');
  const research=env.PACKPROOF_RESEARCH_BUILD === "1";
  const config: DesktopConfig = {
    research,
    channel: channel as ReleaseChannel,
    apiBaseUrl: env.PACKPROOF_API_BASE_URL ?? (channel === 'development' ? 'http://127.0.0.1:3000' : ''),
    webBaseUrl: env.PACKPROOF_WEB_BASE_URL ?? (research ? 'http://127.0.0.1:5173' : 'https://thepackproof.com'),
    cognito: { region: env.PACKPROOF_COGNITO_REGION ?? 'us-east-1', clientId: env.PACKPROOF_COGNITO_CLIENT_ID ?? '', userPoolId: env.PACKPROOF_COGNITO_USER_POOL_ID ?? '' },
    ...(env.PACKPROOF_UPDATES_URL ? { updateUrl: env.PACKPROOF_UPDATES_URL } : {}),
    ...(env.PACKPROOF_SENTRY_DSN || env.SENTRY_DSN ? { sentryDsn: env.PACKPROOF_SENTRY_DSN ?? env.SENTRY_DSN } : {}),
  };
  return validateConfig(config);
}

export function validateConfig(config: DesktopConfig): DesktopConfig {
  if (!['development', 'staging', 'production'].includes(config.channel)) throw new Error('Invalid desktop release channel');
  const url = (value: string, name: string, allowLocal = false) => {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error(`${name} must be configured as an absolute HTTPS URL`); }
    const local = allowLocal && config.channel === 'development' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.hash || parsed.search || (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))) throw new Error(`${name} must use HTTPS without credentials, fragments or query parameters`);
    return parsed.toString().replace(/\/$/, '');
  };
  const apiBaseUrl = url(config.apiBaseUrl, 'PackProof API URL', true);
  const webBaseUrl = url(config.webBaseUrl, 'PackProof website URL', true);
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(config.cognito.region)) throw new Error('Invalid Cognito region');
  if ((config.channel !== 'development' || config.cognito.clientId) && !/^[a-zA-Z0-9]{1,128}$/.test(config.cognito.clientId)) throw new Error('PackProof Cognito app client ID is required');
  if (config.cognito.userPoolId && !/^[a-zA-Z0-9_-]{1,128}$/.test(config.cognito.userPoolId)) throw new Error('Invalid PackProof Cognito user pool ID');
  if(config.research && (config.channel !== 'development' || ![apiBaseUrl,webBaseUrl].every(value=>['127.0.0.1','localhost','[::1]'].includes(new URL(value).hostname)) || config.updateUrl || config.sentryDsn || config.cognito.clientId || config.cognito.userPoolId)) throw new Error('Research desktop requires loopback services, local development identity, and no updates or remote telemetry.');
  return { ...config, apiBaseUrl, webBaseUrl, ...(config.updateUrl ? { updateUrl: url(config.updateUrl, 'Desktop update URL') } : {}) };
}
