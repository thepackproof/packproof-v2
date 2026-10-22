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
  // Reviewed research tables only; no existing canonical table or trigger is changed.
  Object.freeze({"id":"079_rnd_evidence","checksum":"197b8149953a8e04a2216433ab262159ae736e62e7ef6de9f964de4f8547deac"}),
  Object.freeze({"id":"080_rnd_learning","checksum":"59fb22113251274542db12f73c9a047154ea51d07bc1fa236c44585a2841dfc5"}),
  Object.freeze({"id":"081_rnd_platform","checksum":"4d2389b653275c2e669bfaee12b38dff8204578f7be1babbc3d4e70d970b4d98"}),
  Object.freeze({"id":"082_rnd_enrollments","checksum":"0cf27d56b58308f5614cac9d2978997004bfc1c3fbfcdedb285cbf5213239b95"}),
  Object.freeze({"id":"083_rnd_zk","checksum":"854559fa821e2ce91eadf5019fe5656decd69c33e76358f3c789a2c34903f046"}),
  Object.freeze({"id":"084_rnd_annotations","checksum":"4c9d508767baf69d153b007a0f4371deb61f41ca916204c0754a75d13cc2f83c"}),
  Object.freeze({"id":"085_rnd_capture_sidecars","checksum":"194d96a7e658c4d405b9f2e5af92c65b7617e814bc6342418c694f29a235908e"}),
  Object.freeze({"id":"086_rnd_derivative_grants","checksum":"b1ab16a8d2ebf69ee0a692e5a2943aa92722c3272813a122e3e69890d68530a7"}),
  Object.freeze({"id":"087_rnd_source_storage_dedup","checksum":"78e9a7383e377f0df24590e78ddeaacf8f73043377a9dad8e897b00c08e879ad"}),
  // Foundation compatibility is limited to an unactivated organization schema.
  Object.freeze({"id":"088_commit_safe_event_stream","checksum":"2e0cc947a2e08f0f27f408a77894625f2683548491a19b267900fb091d1fa660"}),
  Object.freeze({"id":"089_partner_organizations","checksum":"eb1b08da5232ff2d57bca31eaee940428eaabfacf8f4c29b95cd1001f4d2b502"}),
  Object.freeze({"id":"090_organization_command_results","checksum":"15b4bd98631aabd80909f2ce43ac6c6b45d970ab3a0ee3def018af27d7370471"}),
  Object.freeze({"id":"091_organization_read_visibility","checksum":"23932317aeaa63df421b5c8849e163f0b318904b0aec4a66f39b8a01fa317016"}),
  Object.freeze({"id":"092_organization_policy_recovery","checksum":"d4f0c9555f28fd9009b90a3fc80ef782ea1244f2b4bdd07ba98d01ee956f40a4"}),
]);

export function isReviewedForwardCompatibleMigration(row: {id: string; checksum: string | null}): boolean {
  return FORWARD_COMPATIBLE_MIGRATIONS.some(reviewed => reviewed.id === row.id && reviewed.checksum === row.checksum);
}
