import type { RequestHandler } from 'express';
import type { Database } from '../db/database.js';
import type { Clock } from '../clock.js';
import { DomainError } from '../domain/errors.js';
import { requireActiveAccount } from '../domain/account-access.js';

export interface AdminDeps { db: Database; clock: Clock; devAuth?: boolean; releaseIdentity?: {environment:string} }
export async function getAdminMe(db: Database, userId: string) {
  await requireActiveAccount(db, userId);
  const roles = (await db.query<{role: 'SYSTEM_ADMIN'}>('SELECT role FROM user_system_roles WHERE user_id=$1', [userId])).rows.map(row => row.role);
  return { userId, roles, isAdmin: roles.includes('SYSTEM_ADMIN') };
}
export async function assertSystemAdmin(db: Database, userId: string) {
  if (!(await getAdminMe(db, userId)).isAdmin) throw new DomainError('ADMIN_FORBIDDEN', 'System administrator access is required', 403);
}
export function requireSystemAdmin(deps: AdminDeps): RequestHandler {
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!req.packproofUserId) { next(new DomainError('UNAUTHENTICATED', 'Sign in to continue', 401)); return; }
    void assertSystemAdmin(deps.db, req.packproofUserId).then(() => next()).catch(next);
  };
}
/** Cognito refresh keeps auth_time unchanged; a refreshed token cannot extend the
 * sensitive action window. MFA policy is managed at the existing Cognito pool. */
export function requireRecentAdminAuthentication(deps: AdminDeps): RequestHandler {
  return (req, _res, next) => {
    if (deps.devAuth) { next(); return; }
    const authenticatedAt = req.packproofAuth?.authenticatedAt;
    const now = deps.clock.now().getTime() / 1000;
    if (typeof authenticatedAt !== 'number' || authenticatedAt > now + 30 || now - authenticatedAt > 900) {
      next(new DomainError('ADMIN_REAUTH_REQUIRED', 'Sign out and sign in again before changing administrative settings', 403)); return;
    }
    next();
  };
}
