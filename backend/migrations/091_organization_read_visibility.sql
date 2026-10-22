-- Collection and worker predicates complement, rather than replace, the domain
-- authorization checks. Historical participant rows remain immutable evidence.
CREATE FUNCTION platform_operator_access_active(target_proof TEXT, target_user TEXT)
RETURNS BOOLEAN LANGUAGE SQL STABLE AS $$
 SELECT NOT EXISTS (
   SELECT 1 FROM platform_proof_ownership b
   JOIN platform_memberships m ON m.id=b.operator_membership_id
   JOIN platform_organizations o ON o.id=b.merchant_id
   WHERE b.proof_id=target_proof AND m.user_id=target_user AND
    (m.revoked_at IS NOT NULL OR NOT o.enabled OR
     (m.organization_id<>b.merchant_id AND NOT EXISTS (
       SELECT 1 FROM platform_delegations d JOIN platform_organizations p ON p.id=d.partner_id
       WHERE d.id=b.origin_delegation_id AND d.merchant_id=b.merchant_id
       AND d.partner_id=m.organization_id AND d.revoked_at IS NULL
       AND d.expires_at>CURRENT_TIMESTAMP AND p.enabled
       AND d.operator_ids ? target_user AND d.scopes ? 'capture:request'
     )))
 )
$$;
