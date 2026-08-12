import { Elysia, status, t } from "elysia";
import { getVerifiedRequestPrincipal, requireProjectOrAdminAuth } from "../middleware/auth";
import { markRequestAuditCommitted } from "../services/audit.service";
import {
  isCanonicalMutationTimestamp,
  isProjectMutationId,
  publicProjectMutation,
  readProjectMutation,
  type ReconcileProjectMutationInput,
  type ReconcileProjectMutationResult,
} from "../services/project-mutation.service";
import { reconcileProjectMutationWithAudit } from "../services/project-mutation-reconciliation.service";
import { resolveProxyClientIp } from "../utils/client-ip";
import { VALIDATION_ERROR_BODY } from "../utils/http-validation";

const PROJECT_REF_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
const EVIDENCE_SOURCE_PATTERN_TEXT = "^[a-z0-9][a-z0-9._:-]{0,127}$";
const FAILURE_CODE_PATTERN_TEXT = "^[A-Z][A-Z0-9_]{0,63}$";
const EVIDENCE_FINGERPRINT_PATTERN_TEXT = "^[0-9a-f]{64}$";
const EVIDENCE_SOURCE_PATTERN = new RegExp(EVIDENCE_SOURCE_PATTERN_TEXT);
const FAILURE_CODE_PATTERN = new RegExp(FAILURE_CODE_PATTERN_TEXT);
const EVIDENCE_FINGERPRINT_PATTERN = new RegExp(EVIDENCE_FINGERPRINT_PATTERN_TEXT);
const RECONCILIATION_KEYS = new Set([
  "expected_fencing_epoch", "status", "response_status", "failure_code", "evidence",
]);
const EVIDENCE_KEYS = new Set(["source", "observed_at", "evidence_code", "evidence_fingerprint"]);

type ReconciliationBody = {
  expected_fencing_epoch: number;
  status: "succeeded" | "failed_terminal";
  response_status: number | null;
  failure_code?: string | null;
  evidence: {
    source: string;
    observed_at: string;
    evidence_code: string;
    evidence_fingerprint: string;
  };
};

function reconciliationResponse(projectRef: string, reconciliation: ReconcileProjectMutationResult) {
  if (reconciliation.kind === "updated") {
    return { project_ref: projectRef, mutation: publicProjectMutation(reconciliation.mutation) };
  }
  if (reconciliation.kind === "not_found") return status(404, { error: "Mutation not found" });
  if (reconciliation.kind === "forbidden") {
    return status(403, { error: "Mutation reconciliation is not permitted" });
  }
  if (reconciliation.kind === "invalid_evidence_time") {
    return status(400, { error: "Evidence timestamp is outside the reconciliation window" });
  }
  if (reconciliation.kind === "cas_conflict") {
    return status(409, { error: "Mutation fencing epoch changed" });
  }
  return status(409, { error: `Mutation status '${reconciliation.mutation.status}' cannot be reconciled` });
}

function plainRecord(candidate: unknown): candidate is Record<string, unknown> {
  return Boolean(candidate) && typeof candidate === "object" && !Array.isArray(candidate);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function validReconciliationEvidence(candidate: unknown): boolean {
  if (!plainRecord(candidate) || !hasOnlyKeys(candidate, EVIDENCE_KEYS)) return false;
  return typeof candidate.source === "string" && EVIDENCE_SOURCE_PATTERN.test(candidate.source)
    && typeof candidate.observed_at === "string" && isCanonicalMutationTimestamp(candidate.observed_at)
    && typeof candidate.evidence_code === "string" && FAILURE_CODE_PATTERN.test(candidate.evidence_code)
    && typeof candidate.evidence_fingerprint === "string"
    && EVIDENCE_FINGERPRINT_PATTERN.test(candidate.evidence_fingerprint);
}

function validReconciliationBody(candidate: unknown): candidate is ReconciliationBody {
  if (!plainRecord(candidate) || !hasOnlyKeys(candidate, RECONCILIATION_KEYS)) return false;
  if (!Number.isSafeInteger(candidate.expected_fencing_epoch)
    || Number(candidate.expected_fencing_epoch) < 1) return false;
  if (candidate.status !== "succeeded" && candidate.status !== "failed_terminal") return false;
  if (candidate.response_status !== null
    && (!Number.isInteger(candidate.response_status)
      || Number(candidate.response_status) < 100 || Number(candidate.response_status) > 599)) return false;
  if (candidate.failure_code !== undefined && candidate.failure_code !== null
    && (typeof candidate.failure_code !== "string" || !FAILURE_CODE_PATTERN.test(candidate.failure_code))) return false;
  if (!validReconciliationEvidence(candidate.evidence)) return false;
  if (candidate.status === "succeeded") {
    return Number(candidate.response_status) >= 200 && Number(candidate.response_status) <= 299
      && candidate.failure_code == null;
  }
  return typeof candidate.failure_code === "string";
}

function reconciliationInput(
  projectRef: string,
  mutationId: string,
  body: ReconciliationBody,
): ReconcileProjectMutationInput {
  return {
    projectRef, mutationId, expectedFencingEpoch: body.expected_fencing_epoch,
    status: body.status, responseStatus: body.response_status, failureCode: body.failure_code,
    evidence: {
      source: body.evidence.source,
      observedAt: body.evidence.observed_at,
      evidenceCode: body.evidence.evidence_code,
      evidenceFingerprint: body.evidence.evidence_fingerprint,
    },
  };
}

export const projectMutationRoutes = new Elysia({ prefix: "/v1/projects/:ref/mutations" })
  .onBeforeHandle(async ({ params, request }) => {
    if (!PROJECT_REF_PATTERN.test(params.ref)) return status(400, { error: "Project ref is invalid" });
    const authError = await requireProjectOrAdminAuth(request, params.ref);
    if (authError) return status(authError.status, authError.body);
  })
  .get("/:mutationId", async ({ params }) => {
    if (!isProjectMutationId(params.mutationId)) {
      return status(400, { error: "mutation_id must be a UUIDv4" });
    }
    const mutation = await readProjectMutation({
      projectRef: params.ref,
      mutationId: params.mutationId,
    });
    if (!mutation) return status(404, { error: "Mutation not found" });
    return { project_ref: params.ref, mutation: publicProjectMutation(mutation) };
  }, {
    detail: { tags: ["mutations"], summary: "Read a durable project mutation" },
  })
  .post("/:mutationId/reconcile", async ({ params, body, request }) => {
    if (!isProjectMutationId(params.mutationId)) {
      return status(400, { error: "mutation_id must be a UUIDv4" });
    }
    if (!validReconciliationBody(body)) {
      return status(400, VALIDATION_ERROR_BODY);
    }
    const input = reconciliationInput(params.ref, params.mutationId, body);
    const actor = await getVerifiedRequestPrincipal(request);
    if (!actor) return status(401, { error: "Authentication required" });
    const reconciliation = await reconcileProjectMutationWithAudit({
      mutation: input,
      actor,
      requestId: request.headers.get("x-request-id")?.trim() || crypto.randomUUID(),
      ipAddress: resolveProxyClientIp(request),
      userAgent: request.headers.get("user-agent"),
    });
    if (reconciliation.kind === "updated") markRequestAuditCommitted(request);
    return reconciliationResponse(params.ref, reconciliation);
  }, {
    body: t.Unknown(),
    detail: { tags: ["mutations"], summary: "Reconcile an outcome-unknown project mutation" },
  });
