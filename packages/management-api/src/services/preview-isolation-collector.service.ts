import {
  evaluatePreviewIsolation,
  PreviewEnvironmentError,
  type PreviewEnvironment,
  type PreviewEnvironmentIsolationCheck,
  type PreviewIsolationCheckKey,
  type PreviewIsolationEvidence,
} from "./preview-environment.service";

/** The port is trusted; its returned metadata is still validated at runtime. */
export interface PreviewIsolationObservation {
  ok: boolean;
  collector?: string;
  check?: PreviewIsolationCheckKey;
  project_ref?: string;
  application_id?: string;
  environment_id?: string;
  branch_ref?: string;
  preview_ref?: string;
  release_id?: string;
  /** Explicit null binds an observation to a preview with no configuration revision. */
  configuration_id?: string | null;
  observed_at?: string;
  expires_at?: string;
}
export interface PreviewIsolationCollectorPort {
  collect(check: PreviewIsolationCheckKey, preview: PreviewEnvironment): Promise<PreviewIsolationObservation | null>;
}
export interface PreviewIsolationCollection {
  evidence: PreviewIsolationEvidence;
  isolation: PreviewEnvironmentIsolationCheck[];
  accepted: boolean;
  discarded: Array<{ check: PreviewIsolationCheckKey; reason: string }>;
}

const CHECKS: readonly PreviewIsolationCheckKey[] = [
  "database_role", "storage_permissions", "consumer_identity", "route_access_control",
];
const IDENTITIES = ["project_ref", "application_id", "environment_id", "branch_ref", "preview_ref", "release_id"] as const;
function ownRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return (proto === null || proto === Object.prototype) && Reflect.ownKeys(value).every(key =>
    typeof key === "string" && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
function text(value: unknown, limit = 128): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}
function timestamp(value: unknown): number {
  return text(value, 64) ? Date.parse(value) : Number.NaN;
}
function capturePreview(preview: PreviewEnvironment): PreviewEnvironment {
  try {
    if (!ownRecord(preview) || !Array.isArray(preview.isolation) || preview.isolation.length !== CHECKS.length
      || preview.schema !== "supacloud.preview-environment.v1"
      || IDENTITIES.some(key => !text(preview[key]))
      || !/^[a-f0-9]{64}$/.test(preview.release_id)
      || (preview.configuration_id !== undefined && !text(preview.configuration_id))) throw new Error();
    const keys = preview.isolation.map(check => ownRecord(check) ? check.key : undefined);
    if (new Set(keys).size !== CHECKS.length || CHECKS.some(key => !keys.includes(key))) throw new Error();
    return structuredClone(preview);
  } catch { throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID"); }
}
function discardReason(value: unknown, preview: PreviewEnvironment, check: PreviewIsolationCheckKey, now: number): string | null {
  if (value === null) return "no observation";
  if (!ownRecord(value) || typeof value.ok !== "boolean" || !text(value.collector)) return "invalid observation";
  if (value.check !== check) return "check mismatch";
  for (const key of IDENTITIES) if (value[key] !== preview[key]) return `${key} mismatch`;
  if (!Object.hasOwn(value, "configuration_id") || value.configuration_id !== (preview.configuration_id ?? null)) {
    return "configuration mismatch";
  }
  const observed = timestamp(value.observed_at);
  const expires = timestamp(value.expires_at);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || expires <= observed) return "invalid observation interval";
  if (observed > now) return "observation from the future";
  if (expires <= now) return "observation expired";
  return null;
}

/** Collect exactly four checks; no absent identity, truthy value or empty set may count as verified. */
export async function collectPreviewIsolation(
  preview: PreviewEnvironment, collector: PreviewIsolationCollectorPort, now: Date,
): Promise<PreviewIsolationCollection> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID");
  const at = now.getTime();
  const selected = capturePreview(preview);
  const evidence: PreviewIsolationEvidence = {};
  const discarded: PreviewIsolationCollection["discarded"] = [];
  for (const check of CHECKS) {
    try {
      // A collector cannot rewrite the identity used to validate later observations.
      const observation = await collector.collect(check, structuredClone(selected));
      const reason = discardReason(observation, selected, check, at);
      if (reason !== null || !observation) {
        discarded.push({ check, reason: reason ?? "no observation" });
        continue;
      }
      evidence[check] = { ok: observation.ok === true };
    } catch {
      // Never propagate backend errors that may contain credentials or response bodies.
      discarded.push({ check, reason: "collector error" });
    }
  }
  const evaluation = evaluatePreviewIsolation(selected, evidence);
  return { evidence, isolation: evaluation.isolation, accepted: discarded.length === 0 && evaluation.accepted, discarded };
}
