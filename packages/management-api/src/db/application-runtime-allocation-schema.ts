import type { SQL } from "bun";
import { executeSqlStatements } from "./sql-statements";

export async function ensureApplicationRuntimeAllocationSchema(transaction: SQL): Promise<void> {
  // A metadata deletion must not recycle a port while its runtime outcome is unknown.
  await executeSqlStatements(transaction, `
    CREATE TABLE IF NOT EXISTS application_runtime_allocations (
      project_ref varchar(20) NOT NULL,
      activation_id uuid NOT NULL,
      configuration_id uuid NOT NULL,
      request_fingerprint char(64) NOT NULL,
      runtime jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      retired_at timestamptz,
      retirement_fingerprint char(64),
      PRIMARY KEY (project_ref, activation_id)
    );
    CREATE TABLE IF NOT EXISTS application_runtime_ports (
      port integer PRIMARY KEY CHECK (port >= 1024 AND port <= 65535),
      project_ref varchar(20) NOT NULL,
      activation_id uuid NOT NULL,
      target varchar(63) NOT NULL,
      UNIQUE (project_ref, activation_id, target),
      FOREIGN KEY (project_ref, activation_id)
        REFERENCES application_runtime_allocations (project_ref, activation_id)
    );
    ALTER TABLE application_runtime_allocations
      ADD COLUMN IF NOT EXISTS retired_at timestamptz;
    ALTER TABLE application_runtime_allocations
      ADD COLUMN IF NOT EXISTS retirement_fingerprint char(64);
  `);
}
