CREATE TABLE packing_proof_requests (
  id TEXT PRIMARY KEY,
  buyer_user_id TEXT NOT NULL REFERENCES users(id),
  seller_user_id TEXT NOT NULL REFERENCES users(id),
  order_reference TEXT NOT NULL,
  reference_sha256 TEXT NOT NULL,
  relationship_assurance TEXT NOT NULL CHECK(relationship_assurance='USER_PROVIDED_UNVERIFIED'),
  state TEXT NOT NULL CHECK(state IN ('REQUESTED','ACCEPTED','DECLINED','EXPIRED','CAPTURED')),
  proof_id TEXT REFERENCES proofs(id),
  requested_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  last_reminded_at TIMESTAMPTZ,
  reminder_count INTEGER NOT NULL DEFAULT 0 CHECK(reminder_count BETWEEN 0 AND 3),
  UNIQUE(buyer_user_id,seller_user_id,reference_sha256),
  CHECK(buyer_user_id<>seller_user_id)
);
CREATE INDEX packing_requests_seller_idx ON packing_proof_requests(seller_user_id,requested_at);
CREATE INDEX packing_requests_buyer_idx ON packing_proof_requests(buyer_user_id,requested_at);
