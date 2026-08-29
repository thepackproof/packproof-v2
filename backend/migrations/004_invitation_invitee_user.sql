ALTER TABLE invitations ADD COLUMN invitee_user_id TEXT REFERENCES users (id);

CREATE INDEX invitations_invitee_user_pending_idx
  ON invitations (invitee_user_id, status)
  WHERE invitee_user_id IS NOT NULL;
