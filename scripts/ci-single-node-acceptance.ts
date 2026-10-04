import { parseDeploymentEvidence, type DeploymentEvidence } from "../packages/delivery/src/deployment-evidence";

const apiUrl = (process.env.SUPACLOUD_ACCEPTANCE_API_URL || "").replace(/\/+$/, "");
const token = process.env.SUPACLOUD_ACCEPTANCE_TOKEN;
const projectRef = process.env.SUPACLOUD_ACCEPTANCE_PROJECT_REF || "";
const applicationId = process.env.SUPACLOUD_ACCEPTANCE_APPLICATION_ID || "";
const environmentId = process.env.SUPACLOUD_ACCEPTANCE_ENVIRONMENT_ID || "";
const refresh = process.argv.includes("--refresh-evidence");

if (!apiUrl || !projectRef || !applicationId || !environmentId) {
  throw new Error("SUPACLOUD_ACCEPTANCE_API_URL, project, application and environment are required");
}

const headers: HeadersInit = token ? { authorization: `Bearer ${token}` } : {};

async function readJson(path: string, method = "GET"): Promise<{ status: number; value: unknown }> {
  const response = await fetch(`${apiUrl}${path}`, {
    method, headers, redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error(`Acceptance response is too large: ${path}`);
  let value: unknown = null;
  try { value = text ? JSON.parse(text) : null; } catch { value = { raw: text.slice(0, 512) }; }
  return { status: response.status, value };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function scopePath(): string {
  return `/v1/projects/${encodeURIComponent(projectRef)}/applications/${encodeURIComponent(applicationId)}`
    + `/environments/${encodeURIComponent(environmentId)}`;
}

const health = await readJson("/health");
const runtime = await readJson(`${scopePath()}/runtime`);
let evidenceResponse = await readJson(`${scopePath()}/deployment-evidence`);
if (refresh) {
  evidenceResponse = await readJson(`${scopePath()}/deployment-evidence/refresh`, "POST");
}
const backups = await readJson(`/v1/projects/${encodeURIComponent(projectRef)}/database/backups`);

let evidence: DeploymentEvidence | null = null;
const evidenceEnvelope = record(evidenceResponse.value);
if (evidenceResponse.status === 200 && evidenceEnvelope?.evidence !== null) {
  evidence = parseDeploymentEvidence(evidenceEnvelope?.evidence);
}

const runtimeEnvelope = record(runtime.value);
const readiness = record(runtimeEnvelope?.readiness);
const checks = {
  management_health: health.status === 200 && record(health.value)?.status === "ok",
  runtime_http: runtime.status === 200,
  runtime_ready: readiness?.ready === true,
  deployment_evidence: evidence !== null,
  deployment_confirmed: evidence?.status === "confirmed",
  backup_inventory: backups.status === 200 && Array.isArray(backups.value),
  backup_freshness: evidence?.database.backup.status === "confirmed",
  recovery_drill: evidence?.database.recovery.status === "confirmed",
  authenticated_smoke: evidence?.health.authenticated_smoke === "confirmed",
  rollback_ready: evidence?.rollback.status === "ready",
} as const;
const passed = Object.values(checks).every(Boolean);
const result = {
  schema: "supacloud.single-node-acceptance.v1",
  status: passed ? "confirmed" : "incomplete",
  recorded_at: new Date().toISOString(),
  scope: { project_ref: projectRef, application_id: applicationId, environment_id: environmentId },
  checks,
  evidence_status: evidence?.status ?? "unknown",
  evidence_recorded_at: evidence?.recorded_at ?? null,
  backup_http_status: backups.status,
  refresh_requested: refresh,
};
console.log(JSON.stringify(result, null, 2));
if (!passed) process.exitCode = 1;
