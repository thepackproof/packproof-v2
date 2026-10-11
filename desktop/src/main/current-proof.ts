import type { DesktopApi } from './api';

/** No offline cache fallback: a recommended next action must use present authority. */
export async function readCurrentProof(api: Pick<DesktopApi, 'assertAccount' | 'getProof'>, proofId: string, expectedUserId: string) {
  api.assertAccount(expectedUserId);
  const proof = await api.getProof(proofId);
  api.assertAccount(expectedUserId);
  return proof;
}
