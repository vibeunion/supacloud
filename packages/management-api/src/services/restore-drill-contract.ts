import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { stableStringify } from "../utils/stable-json";

export const RESTORE_SNAPSHOT_SCHEMA = "supacloud.project-restore-snapshot.v1";
export const DRILL_RECEIPT_SCHEMA = "supacloud.project-restore-drill.v1";
export const DRILL_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const COMPONENTS = ["database", "objects", "runtime", "secrets"] as const;
export type RestoreComponent = typeof COMPONENTS[number];
export type RestoreFile = { path: string; bytes: number; sha256: string };
export type RestoreSqlCheck = {
  name: string; category: "permissions" | "queues" | "business"; role: string;
  query: string; claims?: Record<string, unknown>; expected: unknown[];
};
export type RestoreHttpCheck = {
  slug: string; path: string; auth: "anonymous" | "service_role"; status: number; sha256: string;
};
export interface RestoreSnapshot {
  schema: typeof RESTORE_SNAPSHOT_SCHEMA;
  snapshot_id: string;
  project_ref: string;
  incident_at: string;
  recovery_points: Record<RestoreComponent, string>;
  database: {
    kind: "pgbackrest" | "logical-full";
    name: string; admin_role: string; major: number;
    stanza?: string; backup_set?: string; recovery_target?: string;
    repo_cipher_type?: "none" | "aes-256-cbc";
  };
  files: RestoreFile[];
  database_env_keys: string[];
  sql_checks: RestoreSqlCheck[];
  marker_query: string;
  http_checks: RestoreHttpCheck[];
  max_rpo_ms: number;
  max_rto_ms: number;
  signature: string;
}

export function canonicalTime(value: unknown): number {
  if (typeof value !== "string") throw new Error("Invalid recovery timestamp");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) throw new Error("Invalid recovery timestamp");
  return milliseconds;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signDrillDocument(value: Record<string, unknown>, key: string): string {
  if (key.length < 32) throw new Error("Signing key requires at least 32 characters");
  const { signature: _, ...unsigned } = value;
  return createHmac("sha256", key).update(stableStringify(unsigned)).digest("hex");
}

export function verifyDrillDocument(value: Record<string, unknown>, key: string): void {
  const signature = value.signature;
  if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)
    || !timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signDrillDocument(value, key), "hex"))) {
    throw new Error("Invalid drill document signature");
  }
}

export function safeRestorePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1024
    && !value.includes("\\") && !/[\x00-\x1f\x7f]/.test(value)
    && COMPONENTS.includes(value.split("/")[0] as RestoreComponent)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function assertRestoreQuery(query: unknown): asserts query is string {
  if (typeof query !== "string" || query.length > 16_384 || !/^\s*SELECT\s/i.test(query)
    || /[;\x00]/.test(query) || /--|\/\*/.test(query)) {
    throw new Error("Restore checks require one bounded SELECT query");
  }
}

export function parseRestoreSnapshot(raw: string, key: string, now = Date.now()): RestoreSnapshot {
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("Snapshot manifest exceeds 4 MiB");
  const doc = JSON.parse(raw) as RestoreSnapshot;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("Snapshot manifest must be an object");
  verifyDrillDocument(doc as unknown as Record<string, unknown>, key);
  if (doc.schema !== RESTORE_SNAPSHOT_SCHEMA || !DRILL_ID_PATTERN.test(doc.snapshot_id)
    || !/^[A-Za-z0-9_-]{1,20}$/.test(doc.project_ref)) throw new Error("Invalid snapshot identity");
  const incident = canonicalTime(doc.incident_at);
  if (incident > now) throw new Error("Incident time cannot be in the future");
  for (const component of COMPONENTS) {
    if (canonicalTime(doc.recovery_points?.[component]) > incident) throw new Error("Recovery point is after the incident");
  }
  if (!doc.database || !["pgbackrest", "logical-full"].includes(doc.database.kind)
    || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(doc.database.name)
    || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(doc.database.admin_role)
    || ["postgres", "template0", "template1"].includes(doc.database.name)
    || doc.database.admin_role === "supacloud_drill_bootstrap"
    || !Number.isInteger(doc.database.major) || doc.database.major < 14 || doc.database.major > 99) {
    throw new Error("Invalid restore database identity");
  }
  if (doc.database.kind === "pgbackrest") {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(doc.database.stanza ?? "")
      || !/^[A-Za-z0-9_-]{1,128}$/.test(doc.database.backup_set ?? "")
      || canonicalTime(doc.database.recovery_target) > incident) throw new Error("Invalid PITR target");
    if (doc.database.repo_cipher_type !== undefined && !["none", "aes-256-cbc"].includes(doc.database.repo_cipher_type)) {
      throw new Error("Invalid repository cipher type");
    }
  }
  if (!Array.isArray(doc.files) || doc.files.length < 4 || doc.files.length > 20_000) throw new Error("Invalid snapshot inventory");
  const paths = new Set<string>();
  for (const file of doc.files) {
    if (!safeRestorePath(file.path) || paths.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid snapshot file");
    paths.add(file.path);
  }
  if (COMPONENTS.some((component) => ![...paths].some((path) => path.startsWith(`${component}/`)))
    || !paths.has("secrets/runtime-env.enc")) throw new Error("Snapshot component is missing");
  if (doc.database.kind === "logical-full" && (!paths.has("database/database.dump") || !paths.has("database/globals.sql"))) {
    throw new Error("Logical database artifacts are missing");
  }
  if (doc.database.kind === "pgbackrest" && ![...paths].some((path) => path.startsWith("database/repo/"))) {
    throw new Error("pgBackRest repository is missing");
  }
  if (!Array.isArray(doc.database_env_keys) || doc.database_env_keys.length > 16
    || doc.database_env_keys.some((key) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key))) throw new Error("Invalid database environment mapping");
  if (!Array.isArray(doc.sql_checks) || doc.sql_checks.length < 3 || doc.sql_checks.length > 100) throw new Error("Missing SQL checks");
  for (const category of ["permissions", "queues", "business"]) {
    if (!doc.sql_checks.some((check) => check.category === category)) throw new Error("Missing required SQL check category");
  }
  if (doc.sql_checks.filter((check) => check.category === "permissions").length < 2) {
    throw new Error("Both permitted and tenant-isolated permission fixtures are required");
  }
  for (const check of doc.sql_checks) {
    assertRestoreQuery(check.query);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(check.name) || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(check.role)
      || !Array.isArray(check.expected)) throw new Error("Invalid SQL check");
  }
  assertRestoreQuery(doc.marker_query);
  if (!Array.isArray(doc.http_checks) || doc.http_checks.length > 100
    || !doc.http_checks.some((check) => check.auth === "anonymous" && [401, 403].includes(check.status))
    || !doc.http_checks.some((check) => check.auth === "service_role" && check.status >= 200 && check.status < 300)) {
    throw new Error("Authenticated and denied function checks are required");
  }
  for (const check of doc.http_checks) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(check.slug) || typeof check.path !== "string"
      || !/^\/[A-Za-z0-9/_-]*$/.test(check.path) || !["anonymous", "service_role"].includes(check.auth)
      || !Number.isInteger(check.status) || check.status < 200 || check.status > 599
      || !/^[a-f0-9]{64}$/.test(check.sha256)) throw new Error("Invalid HTTP check");
  }
  if (!Number.isSafeInteger(doc.max_rpo_ms) || doc.max_rpo_ms < 0
    || !Number.isSafeInteger(doc.max_rto_ms) || doc.max_rto_ms < 1 || doc.max_rto_ms > 3_600_000) {
    throw new Error("Invalid restore budgets");
  }
  return doc;
}
