export function logIntegrationEvent(entry: {
  adapterKey: string;
  connectionId: string;
  transactionId?: string;
  proofId?: string;
  outcome: string;
  observationCount?: number;
  createdCount?: number;
  carrier?: string;
  mode?: string;
  durationMs?: number;
}): void {
  console.log(
    JSON.stringify({
      source: "packproof.integration",
      adapterKey: entry.adapterKey,
      connectionId: entry.connectionId,
      transactionId: entry.transactionId,
      proofId: entry.proofId,
      outcome: entry.outcome,
      observationCount: entry.observationCount,
      createdCount: entry.createdCount,
      carrier: entry.carrier,
      mode: entry.mode,
      durationMs: entry.durationMs,
    }),
  );
}
