import type { PreviewEnvironment } from "./preview-environment.service";

/**
 * Preview readiness stages are distinct: a composed plan is not a provisioned
 * environment, provisioning is not isolation, isolation is not observed runtime
 * health, and health is not business acceptance. Collapsing them into one
 * "ready" flag is how a plan gets mistaken for a usable preview.
 */
export type PreviewStage = "planned" | "provisioned" | "isolated" | "healthy" | "accepted";

export interface PreviewStatusEvidence {
  /** Observed runtime health of the provisioned application. */
  healthy?: { ok: boolean; detail?: string };
  /** Business acceptance recorded by a named reviewer. */
  accepted?: { by: string; at: string };
}

export interface PreviewStatusReport {
  stage: PreviewStage;
  planned: true;
  provisioned: boolean;
  isolated: boolean;
  healthy: boolean;
  accepted: boolean;
  /** Why the next stage has not been reached. */
  blockers: string[];
}

/**
 * Compute the highest contiguous stage plus the unmet conditions. Each stage
 * requires the previous one, so a `healthy` preview is necessarily isolated and
 * provisioned, and `accepted` requires a recorded, attributable acceptance.
 */
export function evaluatePreviewStatus(
  preview: PreviewEnvironment,
  evidence: PreviewStatusEvidence = {},
): PreviewStatusReport {
  const blockers: string[] = [];

  const failed = preview.components.filter((component) => component.status === "failed");
  const provisioned = failed.length === 0 && preview.components.every((component) => component.status === "ready");
  if (!provisioned) {
    blockers.push(failed.length > 0
      ? `components failed: ${failed.map((component) => component.name).join(", ")}`
      : "components not yet ready");
  }

  const unverified = preview.isolation.filter((check) => check.status !== "verified");
  const isolated = provisioned && unverified.length === 0;
  if (provisioned && !isolated) {
    blockers.push(`isolation not verified: ${unverified.map((check) => check.key).join(", ")}`);
  }

  const healthy = isolated && evidence.healthy?.ok === true;
  if (isolated && !healthy) blockers.push("runtime health not observed");

  const acceptedEvidence = evidence.accepted;
  const accepted = healthy
    && acceptedEvidence !== undefined
    && typeof acceptedEvidence.by === "string" && acceptedEvidence.by.length > 0
    && Number.isFinite(Date.parse(acceptedEvidence.at));
  if (healthy && !accepted) blockers.push("no recorded business acceptance");

  const stage: PreviewStage = accepted ? "accepted"
    : healthy ? "healthy"
    : isolated ? "isolated"
    : provisioned ? "provisioned"
    : "planned";

  return { stage, planned: true, provisioned, isolated, healthy, accepted, blockers };
}