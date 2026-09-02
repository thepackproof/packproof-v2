import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { asRequiredIso } from "./types.js";
import { assertNotFinalized, loadProof, requireParticipant } from "./proof-access.js";

export type BindingScope = "PROOF" | "ASSET" | "TRANSFER";

export interface AssetExternalRefRow {
  id: string;
  proof_id: string;
  asset_id: string | null;
  transfer_id: string | null;
  tenant_key: string;
  external_id: string;
  scope: BindingScope | string;
  source: string;
  supplied_by: string | null;
  created_at: Date | string;
}

export interface AssetExternalRefView {
  bindingId: string;
  proofId: string;
  assetId: string | null;
  transferId: string | null;
  tenantKey: string;
  externalId: string;
  scope: string;
  source: string;
  createdAt: string;
}

export function toBindingView(row: AssetExternalRefRow): AssetExternalRefView {
  return {
    bindingId: row.id,
    proofId: row.proof_id,
    assetId: row.asset_id,
    transferId: row.transfer_id,
    tenantKey: row.tenant_key,
    externalId: row.external_id,
    scope: row.scope,
    source: row.source,
    createdAt: asRequiredIso(row.created_at),
  };
}

export async function listAssetBindings(
  db: Database,
  proofId: string,
): Promise<AssetExternalRefView[]> {
  const found = await db.query<AssetExternalRefRow>(
    `SELECT * FROM proof_asset_external_refs
      WHERE proof_id = $1
      ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return found.rows.map(toBindingView);
}

export async function bindAssetExternalRef(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    scope: BindingScope | string;
    tenantKey: string;
    externalId: string;
    assetId?: string | null;
    transferId?: string | null;
    source?: "PARTICIPANT_SUPPLIED" | "INTEGRATION";
  },
): Promise<AssetExternalRefView> {
  const tenantKey = normalizeTenant(input.tenantKey);
  const externalId = normalizeExternalId(input.externalId);
  const scope = requireScope(input.scope);
  const source = input.source === "INTEGRATION" ? "INTEGRATION" : "PARTICIPANT_SUPPLIED";
  const assetId = input.assetId?.trim() || null;
  const transferId = input.transferId?.trim() || null;
  if (scope === "ASSET" && !assetId) {
    throw new DomainError("INVALID_ASSET_BINDING", "assetId is required for asset bindings", 400);
  }
  if (scope === "TRANSFER" && !transferId) {
    throw new DomainError("INVALID_ASSET_BINDING", "transferId is required for transfer bindings", 400);
  }

  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    await requireParticipant(tx, proofId, actorUserId);

    if (assetId) {
      const asset = await tx.query(
        `SELECT id FROM proof_assets WHERE id = $1 AND proof_id = $2`,
        [assetId, proofId],
      );
      if (!asset.rows[0]) {
        throw new DomainError("ASSET_NOT_FOUND", "Asset not found", 404);
      }
    }
    if (transferId) {
      const transfer = await tx.query(
        `SELECT id FROM custody_transfers WHERE id = $1 AND proof_id = $2`,
        [transferId, proofId],
      );
      if (!transfer.rows[0]) {
        throw new DomainError("TRANSFER_NOT_FOUND", "Transfer not found", 404);
      }
    }

    const existingExternal = await tx.query<AssetExternalRefRow>(
      `SELECT * FROM proof_asset_external_refs
        WHERE tenant_key = $1 AND external_id = $2`,
      [tenantKey, externalId],
    );
    if (existingExternal.rows[0]) {
      const row = existingExternal.rows[0];
      if (row.proof_id !== proofId || row.asset_id !== assetId || row.transfer_id !== transferId) {
        throw new DomainError(
          "ASSET_BINDING_CONFLICT",
          "This external identifier is already bound and cannot be silently rebound",
          409,
        );
      }
      return toBindingView(row);
    }

    if (scope === "ASSET" && assetId) {
      const existingAsset = await tx.query<AssetExternalRefRow>(
        `SELECT * FROM proof_asset_external_refs WHERE asset_id = $1 AND tenant_key = $2`,
        [assetId, tenantKey],
      );
      if (existingAsset.rows[0]) {
        throw new DomainError(
          "ASSET_BINDING_ALREADY_BOUND",
          "This tenant already has an immutable identity binding on this asset",
          409,
        );
      }
    }

    const id = newId("axr");
    const now = clock.now().toISOString();
    try {
      await tx.query(
        `INSERT INTO proof_asset_external_refs (
           id, proof_id, asset_id, transfer_id, tenant_key, external_id,
           scope, source, supplied_by, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, proofId, assetId, transferId, tenantKey, externalId, scope, source, actorUserId, now],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          "ASSET_BINDING_CONFLICT",
          "This external identifier is already bound and cannot be silently rebound",
          409,
        );
      }
      throw error;
    }

    await appendAudit(tx, {
      proofId,
      actorUserId,
      eventType: "ASSET_EXTERNAL_REF_BOUND",
      eventData: { bindingId: id, assetId, transferId, tenantKey, externalId, scope, source },
      at: clock.now(),
    });
    const inserted = await tx.query<AssetExternalRefRow>(
      `SELECT * FROM proof_asset_external_refs WHERE id = $1`,
      [id],
    );
    return toBindingView(inserted.rows[0]);
  });
}

function requireScope(value: unknown): BindingScope {
  if (value === "PROOF" || value === "ASSET" || value === "TRANSFER") {
    return value;
  }
  throw new DomainError("INVALID_ASSET_BINDING", "binding scope is not allowed", 400);
}

function normalizeTenant(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new DomainError("INVALID_ASSET_BINDING", "tenantKey is invalid", 400);
  }
  return value.trim();
}

function normalizeExternalId(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 200) {
    throw new DomainError("INVALID_ASSET_BINDING", "externalId is invalid", 400);
  }
  return value.trim();
}
