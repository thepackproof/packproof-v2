export interface GradingCreation {
  schema: 1;
  userId: string;
  apiBaseUrl: string;
  key: string;
  itemCount: number;
  itemTitle: string;
}
export const gradingCreationKey = (api: string, user: string) => `packproof.grading-create.v1:${encodeURIComponent(api.replace(/\/+$/, ''))}:${encodeURIComponent(user)}`;
export function parseGradingCreation(raw: string | null, api: string, user: string): GradingCreation | null {
  if (!raw) return null;
  const value = JSON.parse(raw) as GradingCreation;
  if (value.schema !== 1 || value.userId !== user || value.apiBaseUrl !== api.replace(/\/+$/, '') ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(value.key) || !Number.isInteger(value.itemCount) || value.itemCount < 1 || value.itemCount > 20 ||
    typeof value.itemTitle !== 'string' || !value.itemTitle.trim() || value.itemTitle.length > 200)
    throw new Error('The saved creation request cannot be read. Recover its details before creating another grading Proof.');
  return value;
}
export function gradingCreationRequest(operation: GradingCreation) {
  return { workflowType: 'GRADING_SUBMISSION', itemCount: operation.itemCount,
    transaction: { itemTitle: operation.itemTitle, quantity: operation.itemCount, idempotencyKey: operation.key } };
}
