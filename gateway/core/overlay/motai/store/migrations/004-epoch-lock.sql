CREATE FUNCTION motai.lock_pool_epoch(target_pool text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,motai
AS $$ SELECT epoch::text FROM motai.pool_state WHERE pool_id=target_pool FOR SHARE $$;
REVOKE ALL ON FUNCTION motai.lock_pool_epoch(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION motai.lock_pool_epoch(text) TO motai_runtime;
INSERT INTO motai.schema_migrations(version) VALUES(4);
