import {
  evaluatePreviewIsolation,
  type PreviewEnvironment,
  type PreviewEnvironmentIsolationCheck,
  type PreviewIsolationCheckKey,
  type PreviewIsolationEvidence,
} from "./preview-environment.service";

/**
 * Isolation evidence must come from a trusted collector, never from an
 * unauthenticated caller's `{ ok: true }`. This module defines the collector
 * port and aggregates its observations fail-closed: a missing, mismatched or
 * expired observation stays `pending`, never `verified`.
 */
export interface PreviewIsolationObservation {
  ok: boolean;
  /** Identity that produced the evidence (probe, platform query, runtime agent). */
  collector?: string;
  /** When the evidence was collected; required for a runtime report to count. */
  observed_at?: string;
  /** When the evidence stops being valid; an expired observation is discarded. */
  expires_at?: string;
  /** The preview this evidence belongs to; a mismatch discards it. */
  preview_ref?: string;
  /** The release this evidence belongs to; a mismatch discards it. */
  release_id?: string;
  /** The configuration revision this evidence belongs to; a mismatch discards it. */
  configuration_id?: string;
}

export interface PreviewIsolationCollectorPort {
  collect(check: PreviewIsolationCheckKey, preview: PreviewEnvironment): Promise<PreviewIsolationObservation | null>;
}

export interface PreviewIsolationCollection {
  evidence: PreviewIsolationEvidence;
  isolation: PreviewEnvironmentIsolationCheck[];
  accepted: boolean;
  /** Checks whose observation was absent, mismatched, expired or errored. */
  discarded: Array<{ check: PreviewIsolationCheckKey; reason: string }>;
}

function discardReason(
  observation: PreviewIsolationObservation | null,
  preview: PreviewEnvironment,
  now: Date,
): string | null {
  if (!observation) return "no observation";
  if (observation.preview_ref !== undefined && observation.preview_ref !== preview.preview_ref) return "preview mismatch";
  if (observation.release_id !== undefined && observation.release_id !== preview.release_id) return "release mismatch";
  if (observation.configuration_id !== undefined && preview.configuration_id !== observation.configuration_id) {
    return "configuration mismatch";
  }
  if (observation.observed_at !== undefined) {
    const observedAt = Date.parse(observation.observed_at);
    if (!Number.isFinite(observedAt)) return "invalid observed_at";
    if (observedAt > now.getTime()) return "observation from the future";
  }
  if (observation.expires_at !== undefined) {
    const expiresAt = Date.parse(observation.expires_at);
    if (!Number.isFinite(expiresAt)) return "invalid expires_at";
    if (expiresAt <= now.getTime()) return "observation expired";
  }
  return null;
}

/**
 * Collect every isolation observation through the port and turn the surviving
 * ones into evidence. Any check without a valid observation is left absent, so
 * `evaluatePreviewIsolation` keeps it `pending` and the preview cannot be
 * accepted on unverifiable evidence.
 */
export async function collectPreviewIsolation(
  preview: PreviewEnvironment,
  collector: PreviewIsolationCollectorPort,
  now: Date,
): Promise<PreviewIsolationCollection> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid collection timestamp");
  const evidence: PreviewIsolationEvidence = {};
  const discarded: PreviewIsolationCollection["discarded"] = [];
  for (const check of preview.isolation) {
    let observation: PreviewIsolationObservation | null = null;
    try {
      observation = await collector.collect(check.key, preview);
    } catch {
      discarded.push({ check: check.key, reason: "collector error" });
      continue;
    }
    const reason = discardReason(observation, preview, now);
    if (reason !== null || !observation) {
      discarded.push({ check: check.key, reason: reason ?? "no observation" });
      continue;
    }
    evidence[check.key] = { ok: observation.ok };
  }
  const evaluation = evaluatePreviewIsolation(preview, evidence);
  return { evidence, isolation: evaluation.isolation, accepted: evaluation.accepted, discarded };
}