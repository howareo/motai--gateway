CREATE TABLE motai.runtime_lease (
 singleton smallint PRIMARY KEY CHECK(singleton=1),
 boot_id uuid NOT NULL,
 lease_pid integer NOT NULL CHECK(lease_pid>0)
);
REVOKE ALL ON motai.runtime_lease FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON motai.runtime_lease TO motai_runtime;
INSERT INTO motai.schema_migrations(version) VALUES(8);
