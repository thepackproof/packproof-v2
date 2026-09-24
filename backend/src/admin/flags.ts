import type { Database } from '../db/database.js';
import { DomainError } from '../domain/errors.js';
export const ADMIN_FLAGS = {
  REGISTRATION_PAUSED: { label: 'Pause new registrations', description: 'Stops new identity creation. Existing users can still sign in.' },
  NEW_CAPTURE_PAUSED: { label: 'Pause new captures', description: 'Stops new capture admission. Existing uploads and capture recovery remain available.' },
} as const;
export type AdminFlag = keyof typeof ADMIN_FLAGS;
export async function requireFeatureAvailable(db: Database, flag: AdminFlag): Promise<void> {
  const row = (await db.query<{enabled:boolean}>('SELECT enabled FROM system_feature_flags WHERE key=$1', [flag])).rows[0];
  if (!row) throw new DomainError('SYSTEM_CONTROL_UNAVAILABLE', 'System configuration is unavailable', 503);
  if (row.enabled) throw new DomainError(flag, flag === 'REGISTRATION_PAUSED' ? 'New registrations are temporarily paused. Please try again later.' : 'New captures are temporarily paused. Existing captures can still be completed.', 503);
}
