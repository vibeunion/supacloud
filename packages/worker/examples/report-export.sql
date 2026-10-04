-- Application-owned example. Install explicitly through the application's migrations.
CREATE SCHEMA IF NOT EXISTS report_export_example;
REVOKE ALL ON SCHEMA report_export_example FROM PUBLIC;
CREATE TABLE report_export_example.requests (
  operation_id uuid PRIMARY KEY,
  actor_id text NOT NULL,
  tenant_id text NOT NULL,
  source_id text NOT NULL,
  revision text NOT NULL,
  group_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','failed')),
  object_id text,
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  row_count integer CHECK (row_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  CHECK ((status='succeeded') = (object_id IS NOT NULL AND sha256 IS NOT NULL AND row_count IS NOT NULL))
);
CREATE FUNCTION report_export_example.protect_result()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  IF NEW.operation_id IS DISTINCT FROM OLD.operation_id OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.source_id IS DISTINCT FROM OLD.source_id
    OR NEW.revision IS DISTINCT FROM OLD.revision OR NEW.group_name IS DISTINCT FROM OLD.group_name THEN
    RAISE EXCEPTION 'REPORT_EXPORT_IMMUTABLE_REQUEST';
  END IF;
  IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'REPORT_EXPORT_IMMUTABLE_RESULT';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER immutable_result BEFORE UPDATE ON report_export_example.requests
FOR EACH ROW EXECUTE FUNCTION report_export_example.protect_result();
REVOKE ALL ON report_export_example.requests FROM PUBLIC;
REVOKE ALL ON FUNCTION report_export_example.protect_result() FROM PUBLIC;
