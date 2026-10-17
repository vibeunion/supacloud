import type { SQL } from "bun";
import { executeSqlStatements } from "./sql-statements";

export async function ensureApplicationCapacitySchema(transaction: SQL): Promise<void> {
  await executeSqlStatements(transaction, `
    CREATE TABLE IF NOT EXISTS application_capacity_policies (
      project_ref varchar(20) PRIMARY KEY REFERENCES projects(ref) ON DELETE CASCADE,
      budget jsonb NOT NULL CHECK (jsonb_typeof(budget) = 'object'),
      updated_by text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE IF NOT EXISTS application_capacity_history (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project_ref varchar(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      budget jsonb CHECK (budget IS NULL OR jsonb_typeof(budget) = 'object'),
      usage jsonb NOT NULL CHECK (jsonb_typeof(usage) = 'object'),
      pressure varchar(16) NOT NULL CHECK (pressure IN ('unknown', 'normal', 'elevated', 'exhausted')),
      active_allocations integer NOT NULL CHECK (active_allocations >= 0),
      active_ports integer NOT NULL CHECK (active_ports >= 0)
    );
    CREATE INDEX IF NOT EXISTS application_capacity_history_project_idx
      ON application_capacity_history(project_ref, generated_at DESC, id DESC);
  `);
}
