CREATE OR REPLACE FUNCTION realtime.auto_attach_notify_trigger()
RETURNS event_trigger AS $fn$
DECLARE
  relation RECORD;
BEGIN
  FOR relation IN
    SELECT c.oid, n.nspname AS schema_name, c.relname
    FROM pg_catalog.pg_event_trigger_ddl_commands() AS ddl
    JOIN pg_catalog.pg_class AS c
      ON c.oid = ddl.objid
    JOIN pg_catalog.pg_namespace AS n
      ON n.oid = c.relnamespace
    WHERE ddl.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
      AND ddl.object_type = 'table'
      AND ddl.schema_name = 'public'
      AND NOT ddl.in_extension
      AND n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND NOT c.relispartition
    GROUP BY c.oid, n.nspname, c.relname
  LOOP
    EXECUTE format(
      'CREATE TRIGGER realtime_notify_trigger AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
      'FOR EACH ROW EXECUTE FUNCTION realtime.notify_postgres_changes()',
      relation.schema_name,
      relation.relname
    );
  END LOOP;
END;
$fn$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog;
