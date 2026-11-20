ALTER TABLE motai.pool_state ADD COLUMN active boolean NOT NULL DEFAULT true;
INSERT INTO motai.schema_migrations(version) VALUES(5);
