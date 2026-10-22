import type { Database } from '../src/db/database.js';
export interface M2Roles { apiRole: string; workerRole: string; }
export interface M2PrivilegeReceipt extends M2Roles {
  schema: 'packproof.m2-database-privileges.v1'; policySha256: string;
  effectivePrivilegesSha256: string; migrations: Record<string, string>;
}
export function verifyM2RuntimePrivileges(db: Database, roles: M2Roles): Promise<M2PrivilegeReceipt>;
export function applyM2RuntimePrivileges(db: Database, roles: M2Roles): Promise<M2PrivilegeReceipt>;
