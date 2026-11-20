CREATE TABLE motai.attempts (
 attempt_id uuid PRIMARY KEY, boot_id uuid NOT NULL, intent jsonb NOT NULL,
 terminal jsonb, terminal_seq bigint UNIQUE,
 started_at timestamptz NOT NULL, pool_id text NOT NULL, channel_id text NOT NULL,
 model_id text NOT NULL, kind text NOT NULL, stream boolean NOT NULL,
 CHECK ((terminal IS NULL) = (terminal_seq IS NULL))
);
CREATE INDEX attempts_started ON motai.attempts(started_at DESC,attempt_id DESC) WHERE terminal IS NOT NULL;
CREATE TABLE motai.event_seq(singleton smallint PRIMARY KEY CHECK(singleton=1),seq bigint NOT NULL CHECK(seq>=0));
INSERT INTO motai.event_seq VALUES(1,0);
CREATE TABLE motai.attempt_events(seq bigint PRIMARY KEY,attempt_id uuid UNIQUE NOT NULL REFERENCES motai.attempts(attempt_id));
CREATE TABLE motai.affinity_bindings(scope_key text PRIMARY KEY,pool_id text NOT NULL,epoch text NOT NULL,channel_id text NOT NULL,credential_version text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE motai.failure_windows(scope_key text NOT NULL,channel_id text NOT NULL,credential_version text NOT NULL,window_started timestamptz NOT NULL,failures integer NOT NULL,PRIMARY KEY(scope_key,channel_id,credential_version));
CREATE TABLE motai.channel_cooldowns(cooldown_key text PRIMARY KEY,until_at timestamptz NOT NULL);
REVOKE ALL ON ALL TABLES IN SCHEMA motai FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON motai.attempts,motai.affinity_bindings,motai.failure_windows,motai.channel_cooldowns TO motai_runtime;
GRANT DELETE ON motai.affinity_bindings,motai.failure_windows,motai.channel_cooldowns TO motai_runtime;
GRANT SELECT,UPDATE ON motai.event_seq TO motai_runtime;
GRANT SELECT,INSERT ON motai.attempt_events TO motai_runtime;
INSERT INTO motai.schema_migrations(version) VALUES(2);
