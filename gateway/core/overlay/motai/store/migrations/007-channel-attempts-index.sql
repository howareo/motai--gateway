CREATE INDEX attempts_channel_started ON motai.attempts(channel_id,started_at DESC,attempt_id DESC) WHERE terminal IS NOT NULL;
INSERT INTO motai.schema_migrations(version) VALUES(7);
