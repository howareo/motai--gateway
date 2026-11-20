CREATE TABLE motai.probe_completion_quarantine (
 attempt_id uuid PRIMARY KEY REFERENCES motai.attempts(attempt_id),
 terminal jsonb NOT NULL CHECK(jsonb_typeof(terminal)='object' AND NOT (terminal ? 'error_detail')),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 256),
 quarantined_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON motai.probe_completion_quarantine FROM PUBLIC;
GRANT SELECT,INSERT ON motai.probe_completion_quarantine TO motai_runtime;
INSERT INTO motai.schema_migrations(version) VALUES(9);
