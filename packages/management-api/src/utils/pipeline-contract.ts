import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const identifier = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]{0,62}(?![\\s\\S])" });
const name = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]{0,99}(?![\\s\\S])" });
const projectId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?![\\s\\S])" });
const staleness = Type.Integer({ minimum: 0, maximum: 1440 });
const batchWait = Type.Integer({ minimum: 0, maximum: 60_000 });
const workers = Type.Integer({ minimum: 1, maximum: 32 });
const slotRecovery = Type.Union([Type.Literal("error"), Type.Literal("recreate")]);

export const pipelineInputSchema = Type.Object({
  name,
  publication_name: identifier,
  destination: Type.Object({
    type: Type.Literal("bigquery"),
    project_id: projectId,
    dataset_id: identifier,
    service_account_key: Type.String({ minLength: 1, maxLength: 64 * 1024 }),
    max_staleness_mins: Type.Optional(staleness),
  }),
  batch_wait_ms: Type.Optional(batchWait),
  sync_workers: Type.Optional(workers),
  slot_recovery: Type.Optional(slotRecovery),
});
export type PipelineRequest = Static<typeof pipelineInputSchema>;

export class PipelineError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "pipeline_error") {
    super(message);
    this.name = "PipelineError";
  }
}

export function invalidPipelineRecord(): PipelineError {
  return new PipelineError("Invalid persisted pipeline record", 503, "pipeline_record_invalid");
}

const serviceAccountSchema = Type.Object({
  type: Type.Literal("service_account"),
  client_email: Type.String({ minLength: 1 }),
  private_key: Type.String({ minLength: 1 }),
});

export function normalizePipelineInput(raw: unknown) {
  if (!Value.Check(pipelineInputSchema, raw)) {
    throw new PipelineError("Invalid pipeline name, publication_name, destination or runtime settings");
  }
  let serviceAccount: unknown;
  try {
    serviceAccount = JSON.parse(raw.destination.service_account_key);
  } catch {
    throw new PipelineError("BigQuery service account key must be valid JSON");
  }
  if (!Value.Check(serviceAccountSchema, serviceAccount)
    || !serviceAccount.client_email.trim() || !serviceAccount.private_key.trim()) {
    throw new PipelineError("BigQuery service account key is missing required service account fields");
  }
  return {
    name: raw.name,
    publication_name: raw.publication_name,
    destination: {
      type: raw.destination.type,
      project_id: raw.destination.project_id,
      dataset_id: raw.destination.dataset_id,
      service_account_key: raw.destination.service_account_key,
      ...(raw.destination.max_staleness_mins === undefined
        ? {} : { max_staleness_mins: raw.destination.max_staleness_mins }),
    },
    batch_wait_ms: raw.batch_wait_ms ?? 5_000,
    sync_workers: raw.sync_workers ?? 4,
    slot_recovery: raw.slot_recovery ?? "error",
  };
}
export type PipelineInput = ReturnType<typeof normalizePipelineInput>;

const settingsSchema = Type.Object({
  batch_wait_ms: Type.Optional(batchWait),
  sync_workers: Type.Optional(workers),
  slot_recovery: Type.Optional(slotRecovery),
  max_staleness_mins: Type.Optional(Type.Union([staleness, Type.Null()])),
});

function readSettings(value: unknown) {
  let settings: unknown = value;
  if (typeof settings === "string") {
    try { settings = JSON.parse(settings); } catch { throw invalidPipelineRecord(); }
  }
  if (!Value.Check(settingsSchema, settings)) throw invalidPipelineRecord();
  return {
    batch_wait_ms: settings.batch_wait_ms ?? 5_000,
    sync_workers: settings.sync_workers ?? 4,
    slot_recovery: settings.slot_recovery ?? "error",
    // Older writes stored null to represent an omitted staleness setting.
    ...(settings.max_staleness_mins == null ? {} : { max_staleness_mins: settings.max_staleness_mins }),
  };
}

const rowSchema = Type.Object({
  id: Type.String({ maxLength: 36, pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
  runtime_id: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  project_ref: Type.String({ minLength: 1 }),
  name,
  publication_name: identifier,
  destination_type: Type.Literal("bigquery"),
  destination_project_id: projectId,
  destination_dataset_id: identifier,
  destination_secret_encrypted: Type.String({ minLength: 1 }),
  settings: Type.Unknown(),
  desired_state: Type.Union([Type.Literal("running"), Type.Literal("stopped")]),
  created_at: Type.Date(),
  updated_at: Type.Date(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeId(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : undefined;
  }
  if (typeof value === "string" && /^[1-9][0-9]{0,15}(?![\s\S])/.test(value)) return Number(value);
  return value;
}

export function readPipelineRows(value: unknown, projectRef: string) {
  if (!Array.isArray(value)) throw invalidPipelineRecord();
  const ids = new Set<string>();
  const runtimes = new Set<number>();
  return Array.from(value, (raw: unknown) => {
    if (!isRecord(raw)) throw invalidPipelineRecord();
    const row = { ...raw, runtime_id: runtimeId(raw.runtime_id) };
    if (!Value.Check(rowSchema, row) || row.project_ref !== projectRef
      || ids.has(row.id) || runtimes.has(row.runtime_id)) throw invalidPipelineRecord();
    ids.add(row.id);
    runtimes.add(row.runtime_id);
    return {
      id: row.id, runtime_id: row.runtime_id, project_ref: row.project_ref,
      name: row.name, publication_name: row.publication_name,
      destination_type: row.destination_type,
      destination_project_id: row.destination_project_id,
      destination_dataset_id: row.destination_dataset_id,
      destination_secret_encrypted: row.destination_secret_encrypted,
      settings: readSettings(row.settings),
      desired_state: row.desired_state,
      created_at: new Date(row.created_at), updated_at: new Date(row.updated_at),
    };
  });
}
export type PipelineRecord = ReturnType<typeof readPipelineRows>[number];

export function readPipelineRow(value: unknown, projectRef: string, id?: string): PipelineRecord | null {
  const rows = readPipelineRows(value, projectRef);
  if (rows.length > 1) throw invalidPipelineRecord();
  const [row] = rows;
  if (!row) return null;
  if (id !== undefined && row.id !== id.toLowerCase()) throw invalidPipelineRecord();
  return row;
}

const credentialsSchema = Type.Object({
  ref: Type.String({ minLength: 1 }),
  db_name: Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" }),
  db_user: identifier,
  db_password: Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" }),
});

export function readPipelineCredentials(value: unknown, projectRef: string) {
  if (!Array.isArray(value) || value.length > 1) throw invalidPipelineRecord();
  if (value.length === 0) throw new PipelineError("Project not found", 404, "project_not_found");
  const row: unknown = value[0];
  if (!Value.Check(credentialsSchema, row) || row.ref !== projectRef) throw invalidPipelineRecord();
  return { database: row.db_name, username: row.db_user, password: row.db_password };
}
