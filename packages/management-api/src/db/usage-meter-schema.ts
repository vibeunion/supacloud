import type { SQL } from "bun";
import { executeSqlStatements } from "./sql-statements";

/**
 * Control-plane ledger for recorded CPU, storage, and function quantities.
 * Receipts are append-only. Counters are hour sums of those receipts.
 * Neither table stores a price.
 */
export const USAGE_METER_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS usage_receipts (
    receipt_id text PRIMARY KEY CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
    project_ref varchar(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
    dimension text NOT NULL CHECK (dimension IN ('cpu', 'storage', 'function')),
    unit text NOT NULL,
    quantity bigint NOT NULL CHECK (quantity > 0 AND quantity <= 9007199254740991),
    observed_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    observation_id text NOT NULL CHECK (observation_id ~ '^[A-Za-z0-9._:@/-]{1,200}$'),
    subject text CHECK (subject IS NULL OR subject ~ '^[A-Za-z0-9._:@/-]{1,200}$'),
    CONSTRAINT usage_receipts_unit_pair CHECK (
      (dimension = 'cpu' AND unit = 'cpu_milliseconds')
      OR (dimension = 'storage' AND unit = 'storage_bytes')
      OR (dimension = 'function' AND unit = 'function_invocations')
    ),
    CONSTRAINT usage_receipts_observation_key UNIQUE (project_ref, observation_id)
  );
  CREATE INDEX IF NOT EXISTS usage_receipts_project_observed_idx
    ON usage_receipts (project_ref, observed_at DESC, observation_id DESC);
  CREATE TABLE IF NOT EXISTS usage_counters (
    project_ref varchar(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
    dimension text NOT NULL CHECK (dimension IN ('cpu', 'storage', 'function')),
    unit text NOT NULL,
    window_start timestamptz NOT NULL,
    quantity bigint NOT NULL,
    receipt_count bigint NOT NULL,
    PRIMARY KEY (project_ref, dimension, window_start),
    CONSTRAINT usage_counters_unit_pair CHECK (
      (dimension = 'cpu' AND unit = 'cpu_milliseconds')
      OR (dimension = 'storage' AND unit = 'storage_bytes')
      OR (dimension = 'function' AND unit = 'function_invocations')
    ),
    CONSTRAINT usage_counters_safe_quantity CHECK (
      quantity > 0 AND quantity <= 9007199254740991
      AND receipt_count > 0 AND receipt_count <= 9007199254740991
    )
  );

  CREATE OR REPLACE FUNCTION prevent_usage_receipt_mutation() RETURNS trigger AS $$
  BEGIN
    RAISE EXCEPTION 'usage_receipts is append-only';
  END;
  $$ LANGUAGE plpgsql;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgrelid = 'usage_receipts'::regclass
        AND tgname = 'usage_receipts_append_only'
        AND NOT tgisinternal
    ) THEN
      CREATE TRIGGER usage_receipts_append_only
        BEFORE UPDATE OR DELETE ON usage_receipts
        FOR EACH ROW EXECUTE FUNCTION prevent_usage_receipt_mutation();
    END IF;
  END;
  $$;

  CREATE OR REPLACE FUNCTION record_project_usage(
    p_project_ref varchar,
    p_dimension text,
    p_unit text,
    p_quantity bigint,
    p_observed_at timestamptz,
    p_observation_id text,
    p_subject text,
    p_receipt_id text,
    p_window_start timestamptz
  ) RETURNS TABLE (
    receipt_id text,
    project_ref varchar,
    dimension text,
    unit text,
    quantity bigint,
    observed_at timestamptz,
    recorded_at timestamptz,
    observation_id text,
    subject text,
    replayed boolean
  )
  LANGUAGE plpgsql
  SET search_path = public
  AS $$
  DECLARE
    existing usage_receipts%ROWTYPE;
    inserted usage_receipts%ROWTYPE;
    current_quantity bigint;
    current_count bigint;
  BEGIN
    IF p_project_ref !~ '^[A-Za-z0-9_-]{1,20}$' THEN
      RAISE EXCEPTION 'USAGE_PROJECT_INVALID';
    END IF;
    IF p_dimension NOT IN ('cpu', 'storage', 'function') THEN
      RAISE EXCEPTION 'USAGE_DIMENSION_INVALID';
    END IF;
    IF (p_dimension = 'cpu' AND p_unit IS DISTINCT FROM 'cpu_milliseconds')
      OR (p_dimension = 'storage' AND p_unit IS DISTINCT FROM 'storage_bytes')
      OR (p_dimension = 'function' AND p_unit IS DISTINCT FROM 'function_invocations') THEN
      RAISE EXCEPTION 'USAGE_UNIT_INVALID';
    END IF;
    IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity > 9007199254740991 THEN
      RAISE EXCEPTION 'USAGE_QUANTITY_INVALID';
    END IF;
    IF p_observation_id !~ '^[A-Za-z0-9._:@/-]{1,200}$' THEN
      RAISE EXCEPTION 'USAGE_OBSERVATION_INVALID';
    END IF;
    IF p_subject IS NOT NULL AND p_subject !~ '^[A-Za-z0-9._:@/-]{1,200}$' THEN
      RAISE EXCEPTION 'USAGE_SUBJECT_INVALID';
    END IF;
    IF p_receipt_id !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'USAGE_RECEIPT_INVALID';
    END IF;
    IF p_observed_at IS NULL
      OR p_window_start IS DISTINCT FROM (date_trunc('hour', p_observed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN
      RAISE EXCEPTION 'USAGE_WINDOW_INVALID';
    END IF;

    INSERT INTO usage_receipts (
      receipt_id, project_ref, dimension, unit, quantity, observed_at, observation_id, subject
    ) VALUES (
      p_receipt_id, p_project_ref, p_dimension, p_unit, p_quantity, p_observed_at, p_observation_id, p_subject
    )
    ON CONFLICT ON CONSTRAINT usage_receipts_observation_key DO NOTHING
    RETURNING * INTO inserted;

    IF NOT FOUND THEN
      SELECT * INTO existing
      FROM usage_receipts
      WHERE usage_receipts.project_ref = p_project_ref
        AND usage_receipts.observation_id = p_observation_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'USAGE_RECORD_MISSING';
      END IF;
      IF existing.dimension IS DISTINCT FROM p_dimension
        OR existing.unit IS DISTINCT FROM p_unit
        OR existing.quantity IS DISTINCT FROM p_quantity
        OR existing.observed_at IS DISTINCT FROM p_observed_at
        OR existing.subject IS DISTINCT FROM p_subject
        OR existing.receipt_id IS DISTINCT FROM p_receipt_id THEN
        RAISE EXCEPTION 'USAGE_OBSERVATION_CONFLICT';
      END IF;
      RETURN QUERY
        SELECT existing.receipt_id, existing.project_ref, existing.dimension, existing.unit,
          existing.quantity, existing.observed_at, existing.recorded_at, existing.observation_id,
          existing.subject, true;
      RETURN;
    END IF;

    SELECT usage_counters.quantity, usage_counters.receipt_count
      INTO current_quantity, current_count
    FROM usage_counters
    WHERE usage_counters.project_ref = p_project_ref
      AND usage_counters.dimension = p_dimension
      AND usage_counters.window_start = p_window_start
    FOR UPDATE;
    IF FOUND AND (
      current_quantity > 9007199254740991 - p_quantity
      OR current_count >= 9007199254740991
    ) THEN
      RAISE EXCEPTION 'USAGE_COUNTER_OVERFLOW';
    END IF;

    INSERT INTO usage_counters (project_ref, dimension, unit, window_start, quantity, receipt_count)
    VALUES (p_project_ref, p_dimension, p_unit, p_window_start, p_quantity, 1)
    ON CONFLICT ON CONSTRAINT usage_counters_pkey DO UPDATE SET
      quantity = usage_counters.quantity + EXCLUDED.quantity,
      receipt_count = usage_counters.receipt_count + 1;

    RETURN QUERY
      SELECT inserted.receipt_id, inserted.project_ref, inserted.dimension, inserted.unit,
        inserted.quantity, inserted.observed_at, inserted.recorded_at, inserted.observation_id,
        inserted.subject, false;
  END;
  $$;
`;

export async function ensureUsageMeterSchema(transaction: SQL): Promise<void> {
  await executeSqlStatements(transaction, USAGE_METER_SCHEMA_SQL);
}
