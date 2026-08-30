import type { Clock } from "../clock.js";
import type { Database } from "../db/database.js";
import { newId } from "../ids.js";
import { appendAudit } from "./audit.js";
import { DomainError, isUniqueViolation } from "./errors.js";
import { PACKPROOF_TRANSACTION_TENANT } from "./trust.js";
import {
  asRequiredIso,
  type ExternalReferenceSource,
  type ProofExternalReferenceRow,
  type ProofRow,
} from "./types.js";

const TENANT_MAX = 80;
const EXTERNAL_ID_MAX = 200;

export interface ProofExternalReferenceView {
  referenceId: string;
  proofId: string;
  tenantKey: string;
  externalTransactionId: string;
  source: ExternalReferenceSource | string;
  suppliedBy: string | null;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export function toExternalReferenceView(
  row: ProofExternalReferenceRow,
): ProofExternalReferenceView {
  return {
    referenceId: row.id,
    proofId: row.proof_id,
    tenantKey: row.tenant_key,
    externalTransactionId: row.external_transaction_id,
    source: row.source,
    suppliedBy: row.supplied_by,
    provenance: asProvenance(row.provenance),
    createdAt: asRequiredIso(row.created_at),
  };
}

export async function listProofExternalReferences(
  db: Database,
  proofId: string,
): Promise<ProofExternalReferenceView[]> {
  const found = await db.query<ProofExternalReferenceRow>(
    `SELECT * FROM proof_external_references
      WHERE proof_id = $1
      ORDER BY created_at ASC, id ASC`,
    [proofId],
  );
  return found.rows.map(toExternalReferenceView);
}

export async function findProofExternalReference(
  db: Database,
  proofId: string,
  tenantKey: string,
): Promise<ProofExternalReferenceView | null> {
  const tenant = normalizeTenantKey(tenantKey);
  const found = await db.query<ProofExternalReferenceRow>(
    `SELECT * FROM proof_external_references
      WHERE proof_id = $1 AND tenant_key = $2`,
    [proofId, tenant],
  );
  return found.rows[0] ? toExternalReferenceView(found.rows[0]) : null;
}

export async function findProofIdByExternalReference(
  db: Database,
  tenantKey: string,
  externalTransactionId: string,
): Promise<string | null> {
  const tenant = normalizeTenantKey(tenantKey);
  const externalId = normalizeExternalTransactionId(externalTransactionId);
  const found = await db.query<{ proof_id: string }>(
    `SELECT proof_id FROM proof_external_references
      WHERE tenant_key = $1 AND external_transaction_id = $2`,
    [tenant, externalId],
  );
  return found.rows[0]?.proof_id ?? null;
}

export async function bindProofExternalReference(
  db: Database,
  clock: Clock,
  actorUserId: string | null,
  input: {
    proofId: string;
    tenantKey: string;
    externalTransactionId: string;
    source: ExternalReferenceSource;
  },
): Promise<ProofExternalReferenceView> {
  const tenantKey = normalizeTenantKey(input.tenantKey);
  const externalTransactionId = normalizeExternalTransactionId(input.externalTransactionId);
  if (input.source !== "PARTICIPANT_SUPPLIED" && input.source !== "INTEGRATION") {
    throw new DomainError("INVALID_EXTERNAL_REFERENCE", "source is not allowed", 400);
  }

  return db.transaction(async (tx) => {
    const proof = await tx.query<ProofRow>(
      `SELECT * FROM proofs WHERE id = $1 FOR UPDATE`,
      [input.proofId],
    );
    if (!proof.rows[0]) {
      throw new DomainError("PROOF_NOT_FOUND", "Proof not found", 404);
    }
    const existing = await tx.query<ProofExternalReferenceRow>(
      `SELECT * FROM proof_external_references
        WHERE tenant_key = $1 AND external_transaction_id = $2`,
      [tenantKey, externalTransactionId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].proof_id !== input.proofId) {
        throw new DomainError(
          "EXTERNAL_REFERENCE_CONFLICT",
          "External transaction reference is already bound to another Proof",
          409,
        );
      }
      return toExternalReferenceView(existing.rows[0]);
    }

    const established = await tx.query<ProofExternalReferenceRow>(
      `SELECT * FROM proof_external_references
        WHERE proof_id = $1 AND tenant_key = $2`,
      [input.proofId, tenantKey],
    );
    if (established.rows[0]) {
      throw new DomainError(
        "EXTERNAL_REFERENCE_ALREADY_BOUND",
        "This tenant already has an immutable identity binding on this Proof",
        409,
      );
    }

    const now = clock.now();
    const referenceId = newId("xref");
    const provenance = {
      kind: "EXTERNAL",
      source: input.source,
      tenantKey,
      externalTransactionId,
      suppliedBy: actorUserId,
      recordedAt: now.toISOString(),
      verifiedByPackProof: false,
    };

    try {
      await tx.query(
        `INSERT INTO proof_external_references (
           id, proof_id, tenant_key, external_transaction_id, source,
           supplied_by, provenance, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          referenceId,
          input.proofId,
          tenantKey,
          externalTransactionId,
          input.source,
          actorUserId,
          JSON.stringify(provenance),
          now.toISOString(),
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const racedLookup = await tx.query<ProofExternalReferenceRow>(
          `SELECT * FROM proof_external_references
            WHERE tenant_key = $1 AND external_transaction_id = $2`,
          [tenantKey, externalTransactionId],
        );
        if (racedLookup.rows[0]?.proof_id === input.proofId) {
          return toExternalReferenceView(racedLookup.rows[0]);
        }
        if (racedLookup.rows[0]) {
          throw new DomainError(
            "EXTERNAL_REFERENCE_CONFLICT",
            "External transaction reference is already bound to another Proof",
            409,
          );
        }
        const racedTenant = await tx.query<ProofExternalReferenceRow>(
          `SELECT * FROM proof_external_references
            WHERE proof_id = $1 AND tenant_key = $2`,
          [input.proofId, tenantKey],
        );
        if (racedTenant.rows[0]) {
          throw new DomainError(
            "EXTERNAL_REFERENCE_ALREADY_BOUND",
            "This tenant already has an immutable identity binding on this Proof",
            409,
          );
        }
        throw new DomainError(
          "EXTERNAL_REFERENCE_CONFLICT",
          "External transaction reference is already bound to another Proof",
          409,
        );
      }
      throw error;
    }

    await appendAudit(tx, {
      proofId: input.proofId,
      actorUserId,
      eventType: "EXTERNAL_REFERENCE_BOUND",
      eventData: {
        referenceId,
        tenantKey,
        externalTransactionId,
        source: input.source,
      },
      at: now,
    });

    const inserted = await tx.query<ProofExternalReferenceRow>(
      `SELECT * FROM proof_external_references WHERE id = $1`,
      [referenceId],
    );
    return toExternalReferenceView(inserted.rows[0]);
  });
}

export async function ensureTransactionExternalReference(
  db: Database,
  clock: Clock,
  actorUserId: string,
  proofId: string,
  externalReference: string | null,
): Promise<ProofExternalReferenceView | null> {
  const established = await findProofExternalReference(
    db,
    proofId,
    PACKPROOF_TRANSACTION_TENANT,
  );
  if (established) {
    return established;
  }
  if (!externalReference) {
    return null;
  }
  return bindProofExternalReference(db, clock, actorUserId, {
    proofId,
    tenantKey: PACKPROOF_TRANSACTION_TENANT,
    externalTransactionId: externalReference,
    source: "PARTICIPANT_SUPPLIED",
  });
}

function normalizeTenantKey(value: string): string {
  const tenant = value.trim().toLowerCase();
  if (!tenant || tenant.length > TENANT_MAX || !/^[a-z0-9][a-z0-9:_-]*$/.test(tenant)) {
    throw new DomainError("INVALID_EXTERNAL_REFERENCE", "tenantKey is invalid", 400);
  }
  if (tenant.startsWith("packproof:") && tenant !== PACKPROOF_TRANSACTION_TENANT) {
    throw new DomainError(
      "INVALID_EXTERNAL_REFERENCE",
      "packproof: tenant keys are reserved",
      400,
    );
  }
  return tenant;
}

function normalizeExternalTransactionId(value: string): string {
  const externalId = value.trim();
  if (!externalId || externalId.length > EXTERNAL_ID_MAX) {
    throw new DomainError(
      "INVALID_EXTERNAL_REFERENCE",
      "externalTransactionId is invalid",
      400,
    );
  }
  return externalId;
}

function asProvenance(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value === "string") {
    return asProvenance(JSON.parse(value) as unknown);
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
