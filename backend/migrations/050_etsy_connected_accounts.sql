-- Etsy reuses the existing OAuth, credential-reference and canonical commerce paths.
-- Existing account identities and immutable Proofs are unchanged.
ALTER TABLE connected_accounts DROP CONSTRAINT connected_accounts_provider_check;
ALTER TABLE connected_accounts ADD CONSTRAINT connected_accounts_provider_check
  CHECK (provider IN ('ebay', 'shopify', 'etsy', 'google', 'facebook'));
