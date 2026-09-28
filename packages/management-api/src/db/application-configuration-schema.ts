import type { SQL } from "bun";
import { executeSqlStatements } from "./sql-statements";

export async function ensureApplicationConfigurationSchema(transaction: SQL): Promise<void> {
  await executeSqlStatements(transaction, `
    CREATE TABLE IF NOT EXISTS application_configuration_revisions (
      project_ref varchar(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      application_id varchar(64) NOT NULL,
      environment_id varchar(64) NOT NULL,
      configuration_id uuid NOT NULL,
      previous_configuration_id uuid,
      request_fingerprint char(64) NOT NULL,
      encrypted_configuration text NOT NULL,
      public_configuration jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (project_ref, application_id, environment_id, configuration_id)
    );
    CREATE TABLE IF NOT EXISTS application_configuration_heads (
      project_ref varchar(20) NOT NULL,
      application_id varchar(64) NOT NULL,
      environment_id varchar(64) NOT NULL,
      configuration_id uuid NOT NULL,
      PRIMARY KEY (project_ref, application_id, environment_id),
      FOREIGN KEY (project_ref, application_id, environment_id, configuration_id)
        REFERENCES application_configuration_revisions
          (project_ref, application_id, environment_id, configuration_id) ON DELETE CASCADE
    );
  `);
}
