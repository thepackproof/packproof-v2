import { DomainError } from '../domain/errors.js';

/** This program is isolated from the frozen release and is disabled by default. */
export interface FuturePlatformConfig {
  enabled: boolean;
  writesEnabled: boolean;
  tenantIds: readonly string[];
  userIds: readonly string[];
}

export function futurePlatformFromEnv(env: NodeJS.ProcessEnv): FuturePlatformConfig {
  const bool = (name: string) => {
    const value = env[name] ?? 'false';
    if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
    return value === 'true';
  };
  const ids = (name: string) => {
    const values = (env[name] ?? '').split(',').map(v => v.trim()).filter(Boolean);
    if (values.length > 100 || values.some(v => !/^[A-Za-z0-9_-]{1,200}$/.test(v)))
      throw new Error(`${name} requires explicit IDs; wildcards are not permitted`);
    return [...new Set(values)];
  };
  return {
    enabled: bool('PACKPROOF_FUTURE_PLATFORM'),
    writesEnabled: bool('PACKPROOF_FUTURE_PLATFORM_WRITES'),
    tenantIds: ids('PACKPROOF_FUTURE_PLATFORM_TENANTS'),
    userIds: ids('PACKPROOF_FUTURE_PLATFORM_USERS'),
  };
}

export function requireFuturePlatform(config: FuturePlatformConfig | undefined,
  subject: { tenantId: string } | { userId: string }, write = false): void {
  const allowed = 'tenantId' in subject
    ? config?.tenantIds.includes(subject.tenantId)
    : config?.userIds.includes(subject.userId);
  if (!config?.enabled || !allowed)
    throw new DomainError('NOT_FOUND', 'This endpoint is not available', 404);
  if (write && !config.writesEnabled)
    throw new DomainError('FUTURE_WRITES_PAUSED', 'New platform records are paused; existing records remain readable', 503);
}
