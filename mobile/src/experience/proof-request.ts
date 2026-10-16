import type { ProofView, TransactionView, ManifestView, ShipmentIntegrityView } from '../v2-api';

export class SupersededProofRequest extends Error {
  constructor() { super('A newer navigation replaced this Proof request.'); }
}

/** A late response cannot replace the record from a more recent selection. */
export function createProofRequestGate() {
  let generation = 0;
  return {
    invalidate() { generation += 1; },
    begin() {
      const expected = ++generation;
      return () => { if (expected !== generation) throw new SupersededProofRequest(); };
    },
  };
}

export async function loadProofSnapshot(proofId: string, ports: {
  getProof(id: string): Promise<ProofView>;
  getTransaction(id: string): Promise<TransactionView>;
  getManifest(id: string): Promise<ManifestView>;
  getShipmentIntegrity(id: string): Promise<ShipmentIntegrityView>;
}, assertCurrent: () => void) {
  assertCurrent();
  const proof = await ports.getProof(proofId);
  assertCurrent();
  if (proof.proofId !== proofId) throw new Error('The server response did not match the requested Proof. Refresh and try again.');
  const [transaction, manifest, integrity] = await Promise.all([
    ports.getTransaction(proof.transactionId),
    proof.status === 'FINALIZED' ? ports.getManifest(proofId) : Promise.resolve(null),
    ports.getShipmentIntegrity(proofId),
  ]);
  assertCurrent();
  if (transaction.transactionId !== proof.transactionId || manifest && manifest.proofId !== proofId)
    throw new Error('The details did not match the requested Proof. Refresh and try again.');
  return { proof, transaction, manifest, integrity };
}
