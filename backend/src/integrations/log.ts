export function logIntegrationEvent(entry: {
  adapterKey: string;
  connectionId: string;
  transactionId?: string;
  proofId?: string;
  outcome: string;
  observationCount?: number;
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
      durationMs: entry.durationMs,
    }),
  );
}
