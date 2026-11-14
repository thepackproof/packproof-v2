-- Case issues are distinct from Proof issues because an order-only case has no
-- fabricated Proof. Source assertions and every historical evaluation remain
-- immutable; current review state is a projection of this action ledger.
CREATE TABLE record_case_issues (
 id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES record_cases(id),
 category TEXT NOT NULL,rule_version TEXT NOT NULL,subject JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,UNIQUE(id,case_id)
);
CREATE TABLE record_case_issue_evaluations (
 id TEXT PRIMARY KEY,issue_id TEXT NOT NULL,case_id TEXT NOT NULL,
 projection_version TEXT NOT NULL,sequence BIGINT NOT NULL CHECK(sequence>0),outcome TEXT NOT NULL CHECK(outcome IN ('different','within_tolerance','not_comparable','suppressed')),
 evaluation JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(issue_id,case_id) REFERENCES record_case_issues(id,case_id),
 UNIQUE(issue_id,projection_version),UNIQUE(issue_id,sequence)
);
CREATE INDEX record_case_issue_evaluation_history ON record_case_issue_evaluations(case_id,issue_id,created_at,id);
CREATE TABLE record_case_issue_actions (
 id TEXT PRIMARY KEY,issue_id TEXT NOT NULL,case_id TEXT NOT NULL,sequence BIGINT NOT NULL CHECK(sequence>0),
 action TEXT NOT NULL CHECK(action IN ('acknowledge','resolve','reopen','note','assign','system_resolve','system_reopen')),
 reason TEXT NOT NULL,actor_user_id TEXT REFERENCES users(id),
 assignee_membership_id TEXT REFERENCES platform_memberships(id),created_at TIMESTAMPTZ NOT NULL,
 FOREIGN KEY(issue_id,case_id) REFERENCES record_case_issues(id,case_id),
 UNIQUE(issue_id,sequence),
 CHECK((action IN ('system_resolve','system_reopen') AND actor_user_id IS NULL AND assignee_membership_id IS NULL) OR (action NOT IN ('system_resolve','system_reopen') AND actor_user_id IS NOT NULL))
);
CREATE INDEX record_case_issue_actions_history ON record_case_issue_actions(case_id,issue_id,sequence);
CREATE TRIGGER record_case_issue_immutable BEFORE UPDATE OR DELETE ON record_case_issues FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_issue_evaluation_immutable BEFORE UPDATE OR DELETE ON record_case_issue_evaluations FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TRIGGER record_case_issue_action_immutable BEFORE UPDATE OR DELETE ON record_case_issue_actions FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_case_rule_runs (
 id TEXT PRIMARY KEY,case_id TEXT NOT NULL REFERENCES record_cases(id),case_revision BIGINT NOT NULL,
 projection_version TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL,UNIQUE(case_id,projection_version)
);
CREATE INDEX record_case_rule_runs_latest ON record_case_rule_runs(case_id,created_at,id);
CREATE TRIGGER record_case_rule_run_immutable BEFORE UPDATE OR DELETE ON record_case_rule_runs FOR EACH ROW EXECUTE FUNCTION platform_record_immutable();
CREATE TABLE record_case_rule_state (
 case_id TEXT PRIMARY KEY REFERENCES record_cases(id),case_revision BIGINT NOT NULL,
 projection_version TEXT,checked_at TIMESTAMPTZ NOT NULL,next_check_at TIMESTAMPTZ NOT NULL,
 error_code TEXT
);
CREATE INDEX record_case_rule_state_due ON record_case_rule_state(next_check_at,case_id);
