CREATE TABLE record_issue_assignments (
 id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES record_issues(id),
 sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 500),
 assignee_membership_id TEXT REFERENCES platform_memberships(id),
 assignee_user_id TEXT REFERENCES users(id), actor_user_id TEXT NOT NULL REFERENCES users(id),
 reason TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 UNIQUE(issue_id,sequence),
 CHECK((assignee_membership_id IS NULL)=(assignee_user_id IS NULL))
);
CREATE TRIGGER record_issue_assignments_immutable BEFORE UPDATE OR DELETE ON record_issue_assignments FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
