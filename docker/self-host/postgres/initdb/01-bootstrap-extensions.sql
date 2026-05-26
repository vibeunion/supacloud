DO $$
DECLARE
  extension_name text;
BEGIN
  FOREACH extension_name IN ARRAY ARRAY[
    'uuid-ossp',
    'pgcrypto',
    'pg_stat_statements',
    'pg_cron',
    'pgaudit',
    'vector',
    'postgis',
    'hypopg',
    'index_advisor',
    'pg_stat_kcache',
    'http',
    'pg_net',
    'pg_graphql',
    'pg_jsonschema',
    'wrappers',
    'pgjwt',
    'pgsodium',
    'supabase_vault'
  ] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_available_extensions
      WHERE name = extension_name
    ) THEN
      EXECUTE format('CREATE EXTENSION IF NOT EXISTS %I CASCADE', extension_name);
    ELSE
      RAISE NOTICE 'Skipping unavailable PostgreSQL extension: %', extension_name;
    END IF;
  END LOOP;
END
$$;
