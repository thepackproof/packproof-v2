import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError } from "./errors.js";
import { asRequiredIso } from "./types.js";
import { assertNotFinalized, loadProof, requireParticipant } from "./proof-access.js";

export const DEFAULT_ASSET_TYPE = "PHYSICAL_ITEM";

export interface ProofAssetRow {
  id: string;
  proof_id: string;
  asset_instance_id: string;
  asset_type: string;
  catalog_descriptor: unknown;
  label_index: number | string;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ProofAssetView {
  assetId: string;
  proofId: string;
  assetInstanceId: string;
  assetType: string;
  catalogDescriptor: Record<string, unknown>;
  labelIndex: number;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export function toAssetView(row: ProofAssetRow): ProofAssetView {
  const labelIndex = Number(row.label_index);
  return {
    assetId: row.id,
    proofId: row.proof_id,
    assetInstanceId: row.asset_instance_id,
    assetType: row.asset_type,
    catalogDescriptor: asDescriptor(row.catalog_descriptor),
    labelIndex,
    label: `Item ${labelIndex}`,
    createdAt: asRequiredIso(row.created_at),
    updatedAt: asRequiredIso(row.updated_at),
  };
}

export async function listProofAssets(db: Database, proofId: string): Promise<ProofAssetView[]> {
  const found = await db.query<ProofAssetRow>(
    `SELECT * FROM proof_assets WHERE proof_id = $1 ORDER BY label_index ASC, id ASC`,
    [proofId],
  );
  return found.rows.map(toAssetView);
}

export async function getProofAsset(
  db: Database,
  proofId: string,
  assetId: string,
): Promise<ProofAssetView> {
  const found = await db.query<ProofAssetRow>(
    `SELECT * FROM proof_assets WHERE id = $1 AND proof_id = $2`,
    [assetId, proofId],
  );
  if (!found.rows[0]) {
    throw new DomainError("ASSET_NOT_FOUND", "Asset not found", 404);
  }
  return toAssetView(found.rows[0]);
}

export async function createProofAssets(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  input: {
    count?: number;
    assetType?: string;
    catalogDescriptor?: unknown;
  } = {},
): Promise<ProofAssetView[]> {
  const count = normalizeCount(input.count);
  const assetType = normalizeAssetType(input.assetType);
  const descriptor = asDescriptor(input.catalogDescriptor);
  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    await requireParticipant(tx, proofId, actorUserId, "SELLER");
    const existing = await tx.query<{ max: string | number | null }>(
      `SELECT MAX(label_index) AS max FROM proof_assets WHERE proof_id = $1`,
      [proofId],
    );
    let nextIndex = Number(existing.rows[0]?.max ?? 0);
    const created: ProofAssetView[] = [];
    const now = clock.now().toISOString();
    for (let i = 0; i < count; i += 1) {
      nextIndex += 1;
      const id = newId("ast");
      const instanceId = newId("ain");
      await tx.query(
        `INSERT INTO proof_assets (
           id, proof_id, asset_instance_id, asset_type, catalog_descriptor,
           label_index, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)`,
        [id, proofId, instanceId, assetType, JSON.stringify(descriptor), nextIndex, now],
      );
      await appendAudit(tx, {
        proofId,
        actorUserId,
        eventType: "ASSET_CREATED",
        eventData: {
          assetId: id,
          assetInstanceId: instanceId,
          labelIndex: nextIndex,
          assetType,
        },
        at: clock.now(),
      });
      created.push(
        toAssetView({
          id,
          proof_id: proofId,
          asset_instance_id: instanceId,
          asset_type: assetType,
          catalog_descriptor: descriptor,
          label_index: nextIndex,
          created_at: now,
          updated_at: now,
        }),
      );
    }
    return created;
  });
}

export async function updateAssetCatalog(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  assetId: string,
  catalogDescriptor: unknown,
): Promise<ProofAssetView> {
  const descriptor = asDescriptor(catalogDescriptor);
  return db.transaction(async (tx) => {
    const proof = await loadProof(tx, proofId, true);
    assertNotFinalized(proof);
    await requireParticipant(tx, proofId, actorUserId, "SELLER");
    const found = await tx.query<ProofAssetRow>(
      `SELECT * FROM proof_assets WHERE id = $1 AND proof_id = $2 FOR UPDATE`,
      [assetId, proofId],
    );
    if (!found.rows[0]) {
      throw new DomainError("ASSET_NOT_FOUND", "Asset not found", 404);
    }
    const now = clock.now().toISOString();
    await tx.query(
      `UPDATE proof_assets
          SET catalog_descriptor = $2::jsonb, updated_at = $3
        WHERE id = $1`,
      [assetId, JSON.stringify(descriptor), now],
    );
    return getProofAsset(tx, proofId, assetId);
  });
}

function normalizeCount(value: unknown): number {
  const count = value == null || value === "" ? 1 : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new DomainError("INVALID_ASSET_COUNT", "count must be an integer from 1 to 50", 400);
  }
  return count;
}

function normalizeAssetType(value: unknown): string {
  if (value == null || value === "") {
    return DEFAULT_ASSET_TYPE;
  }
  if (typeof value !== "string") {
    throw new DomainError("INVALID_ASSET_TYPE", "assetType must be a string", 400);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80) {
    throw new DomainError("INVALID_ASSET_TYPE", "assetType is invalid", 400);
  }
  return trimmed;
}

function asDescriptor(value: unknown): Record<string, unknown> {
  if (value == null || value === "") {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("INVALID_CATALOG_DESCRIPTOR", "catalogDescriptor must be an object", 400);
  }
  const encoded = JSON.stringify(value);
  if (encoded.length > 4096) {
    throw new DomainError("INVALID_CATALOG_DESCRIPTOR", "catalogDescriptor is too large", 400);
  }
  return value as Record<string, unknown>;
}
