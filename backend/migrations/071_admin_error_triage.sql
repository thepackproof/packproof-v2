-- Triage is an operational annotation; source diagnostics remain unmodified.
CREATE TABLE admin_error_triage (
  service TEXT NOT NULL CHECK(length(service) BETWEEN 1 AND 40),
  code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK(status IN ('NEW','INVESTIGATING','RESOLVED','IGNORED')),
  version INTEGER NOT NULL CHECK(version > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY(service,code)
);
