CREATE SCHEMA report_demo;
CREATE TABLE report_demo.sources (
  id uuid PRIMARY KEY, revision text NOT NULL, owner_id text NOT NULL,
  frozen boolean NOT NULL DEFAULT false
);
CREATE TABLE report_demo.rows (
  source_id uuid NOT NULL REFERENCES report_demo.sources(id),
  row_id bigint NOT NULL CHECK(row_id>0),
  label text NOT NULL CHECK(octet_length(label)<=4096), amount_cents bigint NOT NULL,
  PRIMARY KEY(source_id,row_id)
);
CREATE FUNCTION report_demo.guard_snapshot() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.source_id IS DISTINCT FROM OLD.source_id THEN
    RAISE EXCEPTION 'REPORT_SOURCE_IMMUTABLE';
  END IF;
  IF (SELECT frozen FROM report_demo.sources WHERE id=COALESCE(NEW.source_id,OLD.source_id) FOR SHARE) THEN
    RAISE EXCEPTION 'REPORT_SOURCE_IMMUTABLE';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $guard$;
CREATE TRIGGER frozen_snapshot BEFORE INSERT OR UPDATE OR DELETE ON report_demo.rows
  FOR EACH ROW EXECUTE FUNCTION report_demo.guard_snapshot();
CREATE FUNCTION report_demo.guard_source() RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF OLD.frozen THEN RAISE EXCEPTION 'REPORT_SOURCE_IMMUTABLE'; END IF;
  RETURN COALESCE(NEW,OLD);
END $guard$;
CREATE TRIGGER frozen_source BEFORE UPDATE OR DELETE ON report_demo.sources
  FOR EACH ROW EXECUTE FUNCTION report_demo.guard_source();
CREATE TABLE report_demo.requests (
  operation_id uuid PRIMARY KEY, source_id uuid NOT NULL REFERENCES report_demo.sources(id),
  revision text NOT NULL, actor_id text NOT NULL,
  state text NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','completed','revoked','failed')),
  last_attempt integer NOT NULL DEFAULT 0,
  last_error_code text CHECK(last_error_code IS NULL OR last_error_code='REPORT_EXECUTION_FAILED')
);
CREATE TABLE report_demo.chunks (
  operation_id uuid NOT NULL REFERENCES report_demo.requests(operation_id),
  sequence integer NOT NULL, last_row_id bigint NOT NULL, row_count integer NOT NULL,
  digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(operation_id,sequence)
);
CREATE TABLE report_demo.receipts (
  operation_id uuid PRIMARY KEY REFERENCES report_demo.requests(operation_id),
  row_count bigint NOT NULL, completed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON SCHEMA report_demo FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA report_demo FROM PUBLIC;
