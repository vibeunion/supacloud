import { createHash } from "node:crypto";
import { sql } from "../db";
import { getVerifiedRequestPrincipal } from "../middleware/auth";
import { extractProjectRefFromPath } from "../utils/project-auth";
import { resolveProxyClientIp } from "../utils/client-ip";
import { ForbiddenError } from "../utils/errors";
import { resolveTrustedPrincipal } from "./bff-proof.service";
import { verifiedAuditPrincipal } from "./request-audit-principal.service";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SENSITIVE_KEYS = new Set([
  "authorization", "cookie", "token", "accesstoken", "refreshtoken", "idtoken",
  "password", "smtppass", "secret", "secrets", "clientsecret", "apikey",
  "privatekey", "code", "verifier", "codeverifier",
]);
const SENSITIVE_NAME_PATTERN = [
  "authorization", "cookie", "access[_-]?token", "refresh[_-]?token", "id[_-]?token",
  "token", "password", "smtp[_-]?pass", "secrets?", "client[_-]?secret",
  "api[_-]?key", "private[_-]?key", "code[_-]?verifier", "verifier", "code",
].join("|");
const BEARER_PATTERN = /\b(bearer\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi;
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:["']?(?:${SENSITIVE_NAME_PATTERN})["']?)\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|[^\\s,;&#}\\]]+)`,
  "gi",
);

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll("_", "").replaceAll("-", "").toLowerCase();
  return SENSITIVE_KEYS.has(normalized);
}

export type AuditInput = {
  request: Request;
  status?: number;
  action?: string;
  metadata?: Record<string, unknown>;
  source?: string;
};

export type AppendAuditEventInput = {
  projectRef: string | null;
  actor: string;
  actorType: string;
  action: string;
  method: string;
  path: string;
  status?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId: string;
  metadata?: Record<string, unknown>;
  source?: string;
};

function redactedSecretLiteral(literal: string): string {
  const quote = literal[0];
  return quote === '"' || quote === "'" ? `${quote}[REDACTED]${quote}` : "[REDACTED]";
}

export function redactAuditText(text: string): string {
  return text
    .replace(BEARER_PATTERN, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, literal: string) => (
      `${prefix}${redactedSecretLiteral(literal)}`
    ));
}

export function redactAuditValue(auditValue: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof auditValue === "string") return redactAuditText(auditValue);
  if (!auditValue || typeof auditValue !== "object") return auditValue;
  if (seen.has(auditValue)) return "[CIRCULAR]";
  seen.add(auditValue);
  if (Array.isArray(auditValue)) {
    const redacted = auditValue.map((entry) => redactAuditValue(entry, seen));
    seen.delete(auditValue);
    return redacted;
  }
  const output: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(auditValue as Record<string, unknown>)) {
    output[key] = isSensitiveKey(key) ? "[REDACTED]" : redactAuditValue(fieldValue, seen);
  }
  seen.delete(auditValue);
  return output;
}

function canonicalize(auditValue: unknown): unknown {
  if (Array.isArray(auditValue)) return auditValue.map(canonicalize);
  if (!auditValue || typeof auditValue !== "object") return auditValue;
  return Object.fromEntries(
    Object.entries(auditValue as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, fieldValue]) => [key, canonicalize(fieldValue)]),
  );
}

function eventHash(canonicalEvent: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(canonicalEvent))).digest("hex");
}

type AuditChainRow = {
  id: string;
  project_ref: string | null;
  actor: string;
  actor_type: string;
  action: string;
  method: string;
  path: string;
  status: number | null;
  request_id: string;
  source: string;
  metadata: Record<string, unknown> | string | null;
  previous_hash: string | null;
  event_hash: string | null;
  chain_sequence: number | string | null;
  created_at: Date | string;
};

type AuditCheckpoint = {
  project_ref: string;
  last_event_id: string | null;
  last_event_hash: string | null;
  event_count: number | string;
  updated_at?: Date | string;
};

function auditMetadata(metadataValue: AuditChainRow["metadata"]): Record<string, unknown> {
  if (metadataValue && typeof metadataValue === "object" && !Array.isArray(metadataValue)) return metadataValue;
  if (typeof metadataValue !== "string" || !metadataValue.trim()) return {};
  const parsed = JSON.parse(metadataValue) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function auditCreatedAt(timestamp: Date | string): string {
  return timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString();
}

export function auditEventHash(row: Omit<AuditChainRow, "event_hash">): string {
  return eventHash({
    id: row.id,
    project_ref: row.project_ref,
    actor: row.actor,
    actor_type: row.actor_type,
    action: row.action,
    method: row.method,
    path: row.path,
    status: row.status,
    request_id: row.request_id,
    source: row.source,
    metadata: auditMetadata(row.metadata),
    created_at: auditCreatedAt(row.created_at),
    previous_hash: row.previous_hash,
  });
}

export type AuditIntegrityResult = {
  status: "verified" | "mismatch" | "legacy_unverified";
  consistent: boolean;
  reason: string | null;
  total_event_count: number;
  verified_event_count: number;
  checkpoint: AuditCheckpoint | null;
};

type IntegrityFailureInput = {
  status: AuditIntegrityResult["status"];
  reason: string;
  totalCount: number;
  verifiedCount: number;
  checkpoint: AuditCheckpoint | null;
};

function integrityFailure(input: IntegrityFailureInput): AuditIntegrityResult {
  return {
    status: input.status,
    consistent: false,
    reason: input.reason,
    total_event_count: input.totalCount,
    verified_event_count: input.verifiedCount,
    checkpoint: input.checkpoint,
  };
}

function eventMismatchReason(
  row: AuditChainRow,
  expectedSequence: number,
  previousHash: string | null,
): string | null {
  if (Number(row.chain_sequence) !== expectedSequence) return `chain sequence mismatch at ${row.id}`;
  if (row.previous_hash !== previousHash) return `previous hash mismatch at ${row.id}`;
  if (auditEventHash(row) !== row.event_hash) return `event hash mismatch at ${row.id}`;
  return null;
}

function hashedEventFailure(
  rows: AuditChainRow[],
  hashedRows: AuditChainRow[],
  checkpoint: AuditCheckpoint | null,
): AuditIntegrityResult | null {
  let previousHash: string | null = null;
  for (let index = 0; index < hashedRows.length; index += 1) {
    const row = hashedRows[index];
    const reason = eventMismatchReason(row, index + 1, previousHash);
    if (reason) return integrityFailure({ status: "mismatch", reason, totalCount: rows.length, verifiedCount: index, checkpoint });
    previousHash = row.event_hash;
  }
  return null;
}

function checkpointFailure(
  rows: AuditChainRow[],
  hashedRows: AuditChainRow[],
  checkpoint: AuditCheckpoint | null,
): AuditIntegrityResult | null {
  const last = hashedRows.at(-1);
  if (!checkpoint && hashedRows.length > 0) {
    return integrityFailure({ status: "mismatch", reason: "checkpoint is missing", totalCount: rows.length, verifiedCount: hashedRows.length, checkpoint: null });
  }
  if (checkpoint && Number(checkpoint.event_count) !== hashedRows.length) {
    return integrityFailure({ status: "mismatch", reason: "checkpoint event_count mismatch", totalCount: rows.length, verifiedCount: hashedRows.length, checkpoint });
  }
  if (checkpoint && (checkpoint.last_event_id !== (last?.id || null) || checkpoint.last_event_hash !== (last?.event_hash || null))) {
    return integrityFailure({ status: "mismatch", reason: "checkpoint head mismatch", totalCount: rows.length, verifiedCount: hashedRows.length, checkpoint });
  }
  return null;
}

export function verifyAuditChain(
  rows: AuditChainRow[],
  checkpoint: AuditCheckpoint | null,
): AuditIntegrityResult {
  const legacyRows = rows.filter((row) => !row.event_hash);
  const hashedRows = rows
    .filter((row) => row.event_hash)
    .sort((left, right) => Number(left.chain_sequence) - Number(right.chain_sequence));
  const mismatch = hashedEventFailure(rows, hashedRows, checkpoint)
    || checkpointFailure(rows, hashedRows, checkpoint);
  if (mismatch) return mismatch;
  if (legacyRows.length > 0) {
    return integrityFailure({
      status: "legacy_unverified",
      reason: `${legacyRows.length} legacy audit event(s) have no hash`,
      totalCount: rows.length,
      verifiedCount: hashedRows.length,
      checkpoint,
    });
  }
  return { status: "verified", consistent: true, reason: null, total_event_count: rows.length, verified_event_count: hashedRows.length, checkpoint };
}

export function shouldAuditRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.pathname.startsWith("/v1") && WRITE_METHODS.has(request.method.toUpperCase());
}

export async function appendAuditEvent(input: AppendAuditEventInput) {
  const id = crypto.randomUUID();
  const projectChainKey = input.projectRef || "__platform__";
  const metadata = redactAuditValue(input.metadata || {}) as Record<string, unknown>;
  const source = input.source || "management-api";

  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`audit-chain:${projectChainKey}`}))`;
    const [checkpoint] = await tx`
      SELECT last_event_hash, event_count
      FROM audit_log_checkpoints
      WHERE project_ref = ${projectChainKey}
      FOR UPDATE
    `;
    const previousHash = typeof checkpoint?.last_event_hash === "string"
      ? checkpoint.last_event_hash
      : null;
    const chainSequence = Number(checkpoint?.event_count || 0) + 1;
    const createdAt = new Date();
    const hash = auditEventHash({
      id,
      project_ref: input.projectRef,
      actor: input.actor,
      actor_type: input.actorType,
      action: input.action,
      method: input.method,
      path: input.path,
      status: input.status ?? null,
      request_id: input.requestId,
      source,
      metadata,
      created_at: createdAt,
      previous_hash: previousHash,
      chain_sequence: chainSequence,
    });
    const [row] = await tx`
      INSERT INTO audit_logs (
        id, project_ref, actor, actor_type, action, method, path, status,
        ip_address, user_agent, request_id, metadata, source,
        previous_hash, event_hash, chain_sequence, created_at
      ) VALUES (
        ${id}, ${input.projectRef}, ${input.actor}, ${input.actorType}, ${input.action},
        ${input.method}, ${input.path}, ${input.status ?? null}, ${input.ipAddress ?? null},
        ${input.userAgent || ""}, ${input.requestId}, ${JSON.stringify(metadata)}::jsonb,
        ${source}, ${previousHash}, ${hash}, ${chainSequence}, ${createdAt}
      )
      RETURNING *
    `;
    await tx`
      INSERT INTO audit_log_checkpoints (
        project_ref, last_event_id, last_event_hash, event_count, updated_at
      ) VALUES (
        ${projectChainKey}, ${id}, ${hash}, ${chainSequence}, NOW()
      )
      ON CONFLICT (project_ref) DO UPDATE SET
        last_event_id = EXCLUDED.last_event_id,
        last_event_hash = EXCLUDED.last_event_hash,
        event_count = EXCLUDED.event_count,
        updated_at = NOW()
    `;
    return row;
  });
}

export async function verifyProjectAuditIntegrity(projectRef: string): Promise<AuditIntegrityResult> {
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`audit-chain:${projectRef}`}))`;
    const [checkpoint] = await tx`
      SELECT project_ref, last_event_id, last_event_hash, event_count, updated_at
      FROM audit_log_checkpoints WHERE project_ref = ${projectRef}
    ` as AuditCheckpoint[];
    const rows = await tx`
      SELECT id, project_ref, actor, actor_type, action, method, path, status,
             request_id, source, metadata, previous_hash, event_hash, chain_sequence, created_at
      FROM audit_logs WHERE project_ref = ${projectRef}
      ORDER BY chain_sequence ASC NULLS FIRST, id ASC
    ` as AuditChainRow[];
    return verifyAuditChain(rows, checkpoint || null);
  });
}

async function auditPrincipal(request: Request, projectRef: string | null) {
  const invitationPrincipal = verifiedAuditPrincipal(request);
  if (invitationPrincipal) return invitationPrincipal;
  const verified = await getVerifiedRequestPrincipal(request);
  if (verified?.type !== "project" || !projectRef) return verified;
  try {
    return await resolveTrustedPrincipal(request, projectRef);
  } catch (error) {
    if (error instanceof ForbiddenError) return verified;
    throw error;
  }
}

/**
 * Persist synchronously so a successful management mutation cannot be followed
 * by silent audit queue loss. Database errors intentionally propagate.
 */
export async function logAuditEvent(input: AuditInput): Promise<void> {
  const url = new URL(input.request.url);
  const projectRef = extractProjectRefFromPath(url.pathname);
  const principal = await auditPrincipal(input.request, projectRef);
  await appendAuditEvent({
    projectRef,
    actor: principal?.id || "anonymous",
    actorType: principal?.type || "anonymous",
    action: input.action || `${input.request.method.toUpperCase()} ${url.pathname}`,
    method: input.request.method.toUpperCase(),
    path: url.pathname,
    status: input.status ?? null,
    ipAddress: resolveProxyClientIp(input.request),
    userAgent: input.request.headers.get("user-agent") || "",
    requestId: input.request.headers.get("x-request-id") || crypto.randomUUID(),
    metadata: input.metadata || {},
    source: input.source,
  });
}

export async function flushAuditEventsForTests(): Promise<void> {
  // Kept as a no-op compatibility hook. Writes are already durable on return.
}
