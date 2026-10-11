/**
 * Reviewed additive schema receipts that this image can safely read after a
 * later deployment. This is a rollback compatibility boundary, not permission
 * to apply a migration or accept arbitrary future schema.
 */
export const FORWARD_COMPATIBLE_MIGRATIONS = Object.freeze([
  Object.freeze({
    id: '076_first_experience_measurement',
    // Frozen SQL from 0ecae87: nullable study metadata, expanded opt-in event
    // constraint, and a partial index. Existing readers/writers remain valid.
    checksum: '3b80452692918bb3589500d100b773deeb8cddf3c57b6882796e8cd1a13c1157',
  }),
]);

export function isReviewedForwardCompatibleMigration(row: {id: string; checksum: string | null}): boolean {
  return FORWARD_COMPATIBLE_MIGRATIONS.some(reviewed => reviewed.id === row.id && reviewed.checksum === row.checksum);
}
