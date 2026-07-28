import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReplicationRoleStatement,
  normalizePipelineInput,
  renderSupabaseEtlConfig,
} from "../../src/services/pipeline.service";

describe("Supabase ETL pipeline configuration", () => {
  test("renders the upstream BigQuery replicator schema", () => {
    const input = normalizePipelineInput({
      name: "warehouse",
      publication_name: "analytics_publication",
      destination: {
        type: "bigquery",
        project_id: "gcp-project",
        dataset_id: "app_dataset",
        service_account_key: JSON.stringify({
          type: "service_account",
          project_id: "gcp-project",
          client_email: "etl@gcp-project.iam.gserviceaccount.com",
          private_key: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----\n",
        }),
      },
    });
    const config = JSON.parse(renderSupabaseEtlConfig({
      runtimeId: 42,
      source: { host: "127.0.0.1", port: 5432, database: "supa_demo", username: "supa_demo", password: "secret" },
      input,
    }));

    expect(config.destination.big_query).toMatchObject({
      project_id: "gcp-project",
      dataset_id: "app_dataset",
      connection_pool_size: 4,
    });
    expect(JSON.parse(config.destination.big_query.service_account_key).client_email).toBe("etl@gcp-project.iam.gserviceaccount.com");
    expect(config.pipeline).toMatchObject({
      id: 42,
      publication_name: "analytics_publication",
      pg_connection: { name: "supa_demo", username: "supa_demo", password: "secret" },
      run_source_migrations: true,
      table_sync_copy: { type: "include_all_tables" },
    });
  });

  test("rejects malformed identifiers and service account credentials", () => {
    expect(() => normalizePipelineInput({
      name: "bad",
      publication_name: "pub; drop database postgres",
      destination: { type: "bigquery", project_id: "p", dataset_id: "d", service_account_key: "{}" },
    })).toThrow("publication_name");
    expect(() => normalizePipelineInput({
      name: "bad",
      publication_name: "valid_pub",
      destination: { type: "bigquery", project_id: "p", dataset_id: "d", service_account_key: "{}" },
    })).toThrow("service account");
  });

  test("quotes the validated source replication role", () => {
    expect(buildReplicationRoleStatement("supa_demo")).toBe('ALTER ROLE "supa_demo" WITH REPLICATION');
    expect(() => buildReplicationRoleStatement('demo" SUPERUSER')).toThrow("safe PostgreSQL identifier");
  });

  test("runs the ETL container without root or host networking", () => {
    const unit = readFileSync(join(import.meta.dir, "../../../../infrastructure/systemd/supacloud-pipeline@.service"), "utf8");
    expect(unit).toContain("--user 65532:65532");
    expect(unit).toContain("--cap-drop=ALL");
    expect(unit).toContain("--read-only");
    expect(unit).toContain("--network slirp4netns:allow_host_loopback=true");
    expect(unit).not.toContain("--network host");
    expect(unit).not.toContain("--user 0:0");
  });
});
