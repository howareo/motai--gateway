CREATE ROLE motai_owner LOGIN PASSWORD 'synthetic-owner-password';
CREATE ROLE motai_activator LOGIN PASSWORD 'synthetic-activator-password';
CREATE ROLE motai_runtime LOGIN PASSWORD 'synthetic-runtime-password';
CREATE DATABASE motai_gateway OWNER motai_owner;
REVOKE CONNECT ON DATABASE motai_gateway FROM PUBLIC;
GRANT CONNECT ON DATABASE motai_gateway TO motai_owner,motai_activator,motai_runtime;
\connect motai_gateway
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
