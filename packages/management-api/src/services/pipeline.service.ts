import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { getProjectDb, sql } from "../db";
import { decryptSecretIfNeeded, encryptSecretIfNeeded } from "../utils/secret-crypto";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,99}$/;
const GCP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PIPELINE_ROOT = process.env.SUPACLOUD_PIPELINE_CONFIG_DIR || "/etc/supabase/pipelines";
const PIPELINE_UNIT = "supacloud-pipeline@";
let schemaReady: Promise<void> | null = null;

export type PipelineInput = ReturnType<typeof normalizePipelineInput>;

export class PipelineError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "pipeline_error") {
    super(message);
    this.name = "PipelineError";
  }
}

export function normalizePipelineInput(raw: {
  name: string;
  publication_name: string;
  destination: {
    type: string;
    project_id: string;
    dataset_id: string;
    service_account_key: string;
    max_staleness_mins?: number;
  };
  batch_wait_ms?: number;
  sync_workers?: number;
  slot_recovery?: "error" | "recreate";
}) {
  if (!NAME.test(raw.name || "")) throw new PipelineError("name must contain 1-100 safe characters");
  if (!IDENTIFIER.test(raw.publication_name || "")) throw new PipelineError("publication_name must be a PostgreSQL identifier");
  if (raw.destination?.type !== "bigquery") throw new PipelineError("Only the current Supabase Pipelines public-alpha BigQuery destination is supported");
  if (!GCP_ID.test(raw.destination.project_id || "") || !IDENTIFIER.test(raw.destination.dataset_id || "")) {
    throw new PipelineError("BigQuery project_id or dataset_id is invalid");
  }
  let serviceAccount: Record<string, unknown>;
  try {
    serviceAccount = JSON.parse(raw.destination.service_account_key);
  } catch {
    throw new PipelineError("BigQuery service account key must be valid JSON");
  }
  if (serviceAccount.type !== "service_account" || typeof serviceAccount.client_email !== "string" || typeof serviceAccount.private_key !== "string") {
    throw new PipelineError("BigQuery service account key is missing required service account fields");
  }
  const maxStaleness = raw.destination.max_staleness_mins;
  if (maxStaleness !== undefined && (!Number.isInteger(maxStaleness) || maxStaleness < 0 || maxStaleness > 1440)) {
    throw new PipelineError("max_staleness_mins must be an integer between 0 and 1440");
  }
  const batchWait = raw.batch_wait_ms ?? 5_000;
  const workers = raw.sync_workers ?? 4;
  if (!Number.isInteger(batchWait) || batchWait < 0 || batchWait > 60_000) throw new PipelineError("batch_wait_ms must be 0-60000");
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) throw new PipelineError("sync_workers must be 1-32");
  return {
    name: raw.name,
    publication_name: raw.publication_name,
    destination: {
      type: "bigquery" as const,
      project_id: raw.destination.project_id,
      dataset_id: raw.destination.dataset_id,
      service_account_key: raw.destination.service_account_key,
      ...(maxStaleness !== undefined ? { max_staleness_mins: maxStaleness } : {}),
    },
    batch_wait_ms: batchWait,
    sync_workers: workers,
    slot_recovery: raw.slot_recovery === "recreate" ? "recreate" as const : "error" as const,
  };
}

export function renderSupabaseEtlConfig(input: {
  runtimeId: number;
  source: { host: string; port: number; database: string; username: string; password: string };
  input: PipelineInput;
}): string {
  return JSON.stringify({
    destination: {
      big_query: {
        project_id: input.input.destination.project_id,
        dataset_id: input.input.destination.dataset_id,
        service_account_key: input.input.destination.service_account_key,
        ...(input.input.destination.max_staleness_mins !== undefined
          ? { max_staleness_mins: input.input.destination.max_staleness_mins }
          : {}),
        connection_pool_size: 4,
      },
    },
    pipeline: {
      id: input.runtimeId,
      publication_name: input.input.publication_name,
      pg_connection: {
        host: input.source.host,
        hostaddr: null,
        port: input.source.port,
        name: input.source.database,
        username: input.source.username,
        password: input.source.password,
        tls: { trusted_root_certs: "", enabled: false },
        keepalive: { idle_secs: 30, interval_secs: 10, retries: 3 },
      },
      batch: { max_fill_ms: input.input.batch_wait_ms, memory_budget_ratio: 0.2, max_bytes: 8 * 1024 * 1024 },
      table_error_retry_delay_ms: 10_000,
      table_error_retry_max_attempts: 5,
      max_table_sync_workers: input.input.sync_workers,
      max_copy_connections_per_table: 2,
      memory_refresh_interval_ms: 100,
      replication_lag_refresh_interval_ms: 10_000,
      memory_backpressure: { activate_threshold: 0.85, resume_threshold: 0.75 },
      table_sync_copy: { type: "include_all_tables" },
      invalidated_slot_behavior: input.input.slot_recovery,
      run_source_migrations: true,
    },
  });
}

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = sql.unsafe(`
      CREATE TABLE IF NOT EXISTS project_pipelines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        runtime_id bigserial UNIQUE NOT NULL,
        project_ref text NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
        name text NOT NULL,
        publication_name text NOT NULL,
        destination_type text NOT NULL DEFAULT 'bigquery',
        destination_project_id text NOT NULL,
        destination_dataset_id text NOT NULL,
        destination_secret_encrypted text NOT NULL,
        settings jsonb NOT NULL DEFAULT '{}'::jsonb,
        desired_state text NOT NULL DEFAULT 'stopped' CHECK (desired_state IN ('running', 'stopped')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_ref, name)
      );
    `).then(() => undefined).catch((error) => { schemaReady = null; throw error; });
  }
  await schemaReady;
}

async function projectCredentials(ref: string) {
  const [project] = await sql`
    SELECT db_name, db_user, db_password FROM projects
    WHERE ref = ${ref} AND deleted_at IS NULL LIMIT 1
  `;
  if (!project) throw new PipelineError("Project not found", 404, "project_not_found");
  return { database: String(project.db_name), username: String(project.db_user), password: String(project.db_password) };
}

async function assertPublicationReady(database: string, publicationName: string) {
  const projectDb = getProjectDb(database);
  const [walLevel] = await projectDb`SHOW wal_level`;
  if (String(walLevel?.wal_level) !== "logical") {
    throw new PipelineError(
      "Pipelines requires PostgreSQL wal_level=logical",
      409,
      "pipeline_logical_replication_required",
    );
  }
  const [publication] = await projectDb`SELECT 1 FROM pg_publication WHERE pubname = ${publicationName}`;
  if (!publication) throw new PipelineError(`Publication '${publicationName}' was not found`, 404, "publication_not_found");
  const missing = await projectDb`
    SELECT schemaname, tablename FROM pg_publication_tables p
    WHERE p.pubname = ${publicationName}
      AND NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary
        WHERE n.nspname = p.schemaname AND c.relname = p.tablename
      )
    LIMIT 20
  `;
  if (missing.length > 0) {
    throw new PipelineError(
      `BigQuery Pipelines requires primary keys; missing on ${missing.map((row: Record<string, unknown>) => `${row.schemaname}.${row.tablename}`).join(", ")}`,
      409,
      "pipeline_primary_key_required",
    );
  }
}

export function buildReplicationRoleStatement(username: string) {
  if (!IDENTIFIER.test(username)) {
    throw new PipelineError("Project database role is not a safe PostgreSQL identifier", 500, "pipeline_role_invalid");
  }
  return `ALTER ROLE "${username}" WITH REPLICATION`;
}

async function ensureReplicationRole(database: string, username: string) {
  const projectDb = getProjectDb(database);
  const [role] = await projectDb`SELECT rolreplication FROM pg_roles WHERE rolname = ${username}`;
  if (!role) throw new PipelineError("Project database role was not found", 404, "pipeline_role_not_found");
  if (!role.rolreplication) {
    await projectDb.unsafe(buildReplicationRoleStatement(username));
  }
}

async function runSystemctl(action: "start" | "stop" | "restart" | "is-active", runtimeId: number) {
  const unit = `${PIPELINE_UNIT}${runtimeId}.service`;
  const process = Bun.spawn(["systemctl", action, unit], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  return { ok: exitCode === 0, unit, error: stderr.trim() };
}

async function writeRuntimeConfig(row: Record<string, unknown>) {
  const credentials = await projectCredentials(String(row.project_ref));
  const settings = row.settings as Record<string, unknown>;
  const destination = JSON.parse(decryptSecretIfNeeded(String(row.destination_secret_encrypted))) as Record<string, unknown>;
  const normalized = normalizePipelineInput({
    name: String(row.name),
    publication_name: String(row.publication_name),
    destination: {
      type: "bigquery",
      project_id: String(row.destination_project_id),
      dataset_id: String(row.destination_dataset_id),
      service_account_key: JSON.stringify(destination),
      max_staleness_mins: settings.max_staleness_mins as number | undefined,
    },
    batch_wait_ms: settings.batch_wait_ms as number | undefined,
    sync_workers: settings.sync_workers as number | undefined,
    slot_recovery: settings.slot_recovery as "error" | "recreate" | undefined,
  });
  const directory = join(PIPELINE_ROOT, String(row.runtime_id));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, "prod.json");
  await Bun.write(target, renderSupabaseEtlConfig({
    runtimeId: Number(row.runtime_id),
    source: { host: config.pgHost, port: config.pgPort, ...credentials },
    input: normalized,
  }));
  await Bun.spawn(["chmod", "600", target]).exited;
  const chown = Bun.spawn(["chown", "-R", "supacloud-edge:supacloud-edge", directory], { stdout: "ignore", stderr: "ignore" });
  await chown.exited;
}

function publicPipeline(row: Record<string, unknown>, runtimeState?: string) {
  return {
    id: row.id,
    name: row.name,
    publication_name: row.publication_name,
    destination: { type: "bigquery", project_id: row.destination_project_id, dataset_id: row.destination_dataset_id, configured: true },
    settings: row.settings,
    desired_state: row.desired_state,
    runtime_state: runtimeState || "unknown",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const pipelineService = {
  async list(ref: string) {
    await ensureSchema();
    const rows = await sql`SELECT * FROM project_pipelines WHERE project_ref = ${ref} ORDER BY created_at DESC`;
    return { items: rows.map((row: Record<string, unknown>) => publicPipeline(row)), total: rows.length };
  },

  async create(ref: string, raw: Parameters<typeof normalizePipelineInput>[0]) {
    await ensureSchema();
    const input = normalizePipelineInput(raw);
    const credentials = await projectCredentials(ref);
    await assertPublicationReady(credentials.database, input.publication_name);
    try {
      const [row] = await sql`
        INSERT INTO project_pipelines
          (project_ref, name, publication_name, destination_project_id, destination_dataset_id, destination_secret_encrypted, settings)
        VALUES
          (${ref}, ${input.name}, ${input.publication_name}, ${input.destination.project_id}, ${input.destination.dataset_id},
           ${encryptSecretIfNeeded(input.destination.service_account_key)},
           ${JSON.stringify({ batch_wait_ms: input.batch_wait_ms, sync_workers: input.sync_workers, slot_recovery: input.slot_recovery, max_staleness_mins: input.destination.max_staleness_mins ?? null })}::jsonb)
        RETURNING *
      `;
      return publicPipeline(row);
    } catch (error: unknown) {
      if ((error as { code?: string }).code === "23505") throw new PipelineError("A pipeline with this name already exists", 409, "pipeline_conflict");
      throw error;
    }
  },

  async find(ref: string, id: string) {
    await ensureSchema();
    const [row] = await sql`SELECT * FROM project_pipelines WHERE project_ref = ${ref} AND id = ${id}`;
    if (!row) throw new PipelineError("Pipeline not found", 404, "pipeline_not_found");
    const runtime = await runSystemctl("is-active", Number(row.runtime_id));
    return { row, public: publicPipeline(row, runtime.ok ? "running" : "stopped") };
  },

  async action(ref: string, id: string, action: "start" | "stop" | "restart") {
    const found = await this.find(ref, id);
    if (action !== "stop") {
      const credentials = await projectCredentials(ref);
      await assertPublicationReady(credentials.database, String(found.row.publication_name));
      await ensureReplicationRole(credentials.database, credentials.username);
      await writeRuntimeConfig(found.row);
    }
    const runtime = await runSystemctl(action, Number(found.row.runtime_id));
    if (!runtime.ok) throw new PipelineError(runtime.error || `Failed to ${action} pipeline runtime`, 503, "pipeline_runtime_unavailable");
    const desiredState = action === "stop" ? "stopped" : "running";
    const [row] = await sql`
      UPDATE project_pipelines SET desired_state = ${desiredState}, updated_at = now()
      WHERE project_ref = ${ref} AND id = ${id} RETURNING *
    `;
    return publicPipeline(row, desiredState === "running" ? "running" : "stopped");
  },

  async remove(ref: string, id: string) {
    const found = await this.find(ref, id);
    await runSystemctl("stop", Number(found.row.runtime_id));
    await rm(join(PIPELINE_ROOT, String(found.row.runtime_id)), { recursive: true, force: true });
    await sql`DELETE FROM project_pipelines WHERE project_ref = ${ref} AND id = ${id}`;
    return { id, deleted: true };
  },
};
