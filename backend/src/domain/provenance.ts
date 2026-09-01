import { DomainError } from "./errors.js";
import { asRequiredIso } from "./types.js";
import type { TransactionIntegrationIdentityRow } from "./types.js";

export const PROVENANCE_SOURCES = [
  "MARKETPLACE_API",
  "STOREFRONT_API",
  "SHIPPING_PROVIDER_API",
  "LABEL_SCAN",
  "PARTICIPANT_SUPPLIED",
] as const;

export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

export interface ImportedBuyer {
  externalId: string | null;
  displayName: string | null;
  email: string | null;
}

export interface TransactionProvenanceView {
  source: ProvenanceSource | string;
  adapterKey: string;
  provider: string;
  tenantKey: string;
  externalTransactionId: string;
  sourceRecordId: string | null;
  importedAt: string;
  payloadSha256: string | null;
  buyer: ImportedBuyer | null;
}

export interface ImportMetadata {
  source: ProvenanceSource;
  adapterKey: string;
  provider: string;
  tenantKey: string;
  sourceRecordId: string | null;
  importedAt: string;
  payloadSha256: string | null;
  buyer: ImportedBuyer | null;
  providerIdentifiers?: Record<string, unknown> | null;
}

export function isProvenanceSource(value: unknown): value is ProvenanceSource {
  return typeof value === "string" && (PROVENANCE_SOURCES as readonly string[]).includes(value);
}

export function tenantKeyForImport(
  provider: string,
  source: ProvenanceSource,
  externalAccountReference?: string | null,
): string {
  const prefix =
    source === "STOREFRONT_API"
      ? "storefront"
      : source === "SHIPPING_PROVIDER_API"
        ? "shipping"
        : source === "LABEL_SCAN"
          ? "label"
          : "marketplace";
  const account = externalAccountReference?.trim().toLowerCase();
  if (account) {
    return `${prefix}:${provider}:${account}`;
  }
  return `${prefix}:${provider}`;
}

export function asMetadataRecord(value: unknown): Record<string, unknown> {
  if (value == null) {
    return {};
  }
  if (typeof value === "string") {
    try {
      return asMetadataRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ...(value as Record<string, unknown>) };
  }
  return {};
}

export function readImportMetadata(metadata: unknown): ImportMetadata | null {
  const record = asMetadataRecord(metadata);
  const raw = record.import;
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const importRecord = raw as Record<string, unknown>;
  if (!isProvenanceSource(importRecord.source) || typeof importRecord.adapterKey !== "string") {
    return null;
  }
  return {
    source: importRecord.source,
    adapterKey: importRecord.adapterKey,
    provider: typeof importRecord.provider === "string" ? importRecord.provider : importRecord.adapterKey,
    tenantKey: typeof importRecord.tenantKey === "string" ? importRecord.tenantKey : "",
    sourceRecordId:
      typeof importRecord.sourceRecordId === "string" ? importRecord.sourceRecordId : null,
    importedAt: typeof importRecord.importedAt === "string" ? importRecord.importedAt : "",
    payloadSha256:
      typeof importRecord.payloadSha256 === "string" ? importRecord.payloadSha256 : null,
    buyer: readBuyer(importRecord.buyer),
  };
}

export function writeImportMetadata(
  metadata: unknown,
  importMeta: ImportMetadata,
): Record<string, unknown> {
  const record = asMetadataRecord(metadata);
  return {
    ...record,
    import: {
      source: importMeta.source,
      adapterKey: importMeta.adapterKey,
      provider: importMeta.provider,
      tenantKey: importMeta.tenantKey,
      sourceRecordId: importMeta.sourceRecordId,
      importedAt: importMeta.importedAt,
      payloadSha256: importMeta.payloadSha256,
      buyer: buyerMetadata(importMeta.buyer),
      ...(importMeta.providerIdentifiers
        ? { providerIdentifiers: importMeta.providerIdentifiers }
        : {}),
    },
  };
}

export function provenanceFromIdentity(
  identity: TransactionIntegrationIdentityRow | null | undefined,
  metadata: unknown,
): TransactionProvenanceView | null {
  if (!identity) {
    return null;
  }
  const stored = readImportMetadata(metadata);
  return {
    source: identity.source,
    adapterKey: identity.adapter_key,
    provider: stored?.provider || providerFromTenant(identity.tenant_key),
    tenantKey: identity.tenant_key,
    externalTransactionId: identity.external_transaction_id,
    sourceRecordId: stored?.sourceRecordId ?? null,
    importedAt: stored?.importedAt || asRequiredIso(identity.created_at),
    payloadSha256: stored?.payloadSha256 ?? null,
    buyer: stored?.buyer
      ? stored.buyer.email
        ? stored.buyer
        : { externalId: stored.buyer.externalId, displayName: stored.buyer.displayName, email: null }
      : null,
  };
}

export function manifestProvenance(
  provenance: TransactionProvenanceView | null | undefined,
): Record<string, unknown> | undefined {
  if (!provenance) {
    return undefined;
  }
  return {
    source: provenance.source,
    adapterKey: provenance.adapterKey,
    provider: provenance.provider,
    tenantKey: provenance.tenantKey,
    sourceRecordId: provenance.sourceRecordId,
    importedAt: provenance.importedAt,
    payloadSha256: provenance.payloadSha256,
  };
}

export function requireProvenanceSource(value: unknown, field = "provenance.source"): ProvenanceSource {
  if (!isProvenanceSource(value)) {
    throw new DomainError(
      "INVALID_IMPORTED_TRANSACTION",
      `${field} must be a known provenance source`,
      400,
    );
  }
  return value;
}

function providerFromTenant(tenantKey: string): string {
  const parts = tenantKey.split(":");
  return parts[1] ?? tenantKey;
}

function buyerMetadata(buyer: ImportedBuyer | null): Record<string, unknown> | null {
  if (!buyer) {
    return null;
  }
  return {
    externalId: buyer.externalId,
    displayName: buyer.displayName,
    ...(buyer.email ? { email: buyer.email } : {}),
  };
}

function readBuyer(value: unknown): ImportedBuyer | null {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const buyer: ImportedBuyer = {
    externalId: typeof record.externalId === "string" ? record.externalId : null,
    displayName: typeof record.displayName === "string" ? record.displayName : null,
    email: typeof record.email === "string" ? record.email : null,
  };
  if (!buyer.externalId && !buyer.displayName && !buyer.email) {
    return null;
  }
  return {
    externalId: buyer.externalId,
    displayName: buyer.displayName,
    email: buyer.email,
  };
}
