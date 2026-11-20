CREATE TABLE motai.operations(operation_id uuid PRIMARY KEY,kind text NOT NULL,pool_id text,response jsonb NOT NULL);
GRANT SELECT,INSERT ON motai.operations TO motai_activator,motai_runtime;
CREATE TABLE motai.probe_runs(client_run_id uuid PRIMARY KEY,request jsonb NOT NULL,response jsonb NOT NULL,boot_id uuid NOT NULL);
GRANT SELECT,INSERT,UPDATE ON motai.probe_runs TO motai_runtime;
INSERT INTO motai.schema_migrations(version) VALUES(3);
