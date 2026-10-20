-- Read-only baseline. Save output in the restricted release-evidence location.
-- This never assigns ownership based on names, email domains or order numbers.
BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database, current_user AS principal, version() AS engine;
SELECT id,checksum,applied_at FROM schema_migrations ORDER BY id;
SELECT t.id AS legacy_tenant,t.environment,t.owner_user_id,u.status AS owner_status,
 COUNT(p.proof_id) AS proof_count,COUNT(DISTINCT pp.user_id) AS recorded_sellers,
 'EXPLICIT_MERCHANT_MAPPING_REQUIRED' AS disposition
FROM api_tenants t JOIN users u ON u.id=t.owner_user_id
LEFT JOIN api_tenant_proofs p ON p.tenant_id=t.id
LEFT JOIN proof_participants pp ON pp.proof_id=p.proof_id AND pp.role='SELLER'
GROUP BY t.id,t.environment,t.owner_user_id,u.status ORDER BY t.id;
SELECT proof_id,id AS manifest_id,sha256,octet_length(canonical_json) AS canonical_bytes,
 signature_algorithm,signing_key_id FROM final_manifests ORDER BY proof_id;
SELECT transaction_id,COUNT(*) FROM proofs GROUP BY transaction_id HAVING COUNT(*)>1;
SELECT proof_id,role,COUNT(*) FROM proof_participants GROUP BY proof_id,role HAVING COUNT(*)>1;
SELECT tenant_id,external_id,COUNT(*) FROM api_tenant_proofs GROUP BY tenant_id,external_id HAVING COUNT(*)>1;
COMMIT;
