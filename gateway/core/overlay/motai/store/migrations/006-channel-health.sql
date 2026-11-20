CREATE TABLE motai.channel_health (
 pool_id text NOT NULL,channel_id text NOT NULL,credential_ref text NOT NULL,credential_version text NOT NULL,
 state text NOT NULL CHECK(state IN ('available','exhausted','auth_invalid')),
 revision bigint NOT NULL CHECK(revision>0),observed_at timestamptz NOT NULL,
 PRIMARY KEY(pool_id,channel_id,credential_ref,credential_version)
);
REVOKE ALL ON motai.channel_health FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON motai.channel_health TO motai_runtime,motai_activator;
ALTER TABLE motai.operations ADD COLUMN request_hash text;
ALTER TABLE motai.channel_cooldowns ADD COLUMN reason text NOT NULL DEFAULT 'ordinary' CHECK(reason IN ('ordinary','retry_after'));
ALTER TABLE motai.channel_cooldowns ADD COLUMN observed_at timestamptz NOT NULL DEFAULT now();
INSERT INTO motai.schema_migrations(version) VALUES(6);
