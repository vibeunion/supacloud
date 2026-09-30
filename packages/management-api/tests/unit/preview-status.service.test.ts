import { expect, test } from "bun:test";
import { composePreviewEnvironment, type PreviewEnvironment } from "../../src/services/preview-environment.service";
import { evaluatePreviewStatus } from "../../src/services/preview-status.service";

const base = {
  previewRef: "pr-7",
  projectRef: "demo",
  applicationId: "reviews",
  environmentId: "preview",
  releaseId: "a".repeat(64),
  source: { branch: "feature/orders", commit: "b".repeat(40) },
};

function staged(componentStatus: "planned" | "ready" | "failed", isolationStatus: "pending" | "verified" | "failed"): PreviewEnvironment {
  const preview = composePreviewEnvironment(base);
  return {
    ...preview,
    components: preview.components.map((component) => ({ ...component, status: componentStatus })),
    isolation: preview.isolation.map((check) => ({ ...check, status: isolationStatus })),
  };
}

test("separates planned, provisioned, isolated, healthy and accepted", () => {
  const planned = evaluatePreviewStatus(staged("planned", "pending"));
  expect(planned.stage).toBe("planned");
  expect(planned.blockers).toContain("components not yet ready");

  const provisioned = evaluatePreviewStatus(staged("ready", "pending"));
  expect(provisioned.stage).toBe("provisioned");
  expect(provisioned.provisioned).toBe(true);
  expect(provisioned.isolated).toBe(false);

  const isolated = evaluatePreviewStatus(staged("ready", "verified"));
  expect(isolated.stage).toBe("isolated");
  expect(isolated.blockers).toContain("runtime health not observed");

  const healthy = evaluatePreviewStatus(staged("ready", "verified"), { healthy: { ok: true } });
  expect(healthy.stage).toBe("healthy");
  expect(healthy.blockers).toContain("no recorded business acceptance");

  const accepted = evaluatePreviewStatus(staged("ready", "verified"), {
    healthy: { ok: true },
    accepted: { by: "reviewer@example.com", at: "2026-09-30T00:00:00.000Z" },
  });
  expect(accepted.stage).toBe("accepted");
  expect(accepted.blockers).toEqual([]);
});

test("refuses to advance past a failure or an unattributable acceptance", () => {
  const failed = evaluatePreviewStatus(staged("failed", "verified"), { healthy: { ok: true } });
  expect(failed.stage).toBe("planned");
  expect(failed.blockers.some((blocker) => blocker.includes("components failed"))).toBe(true);
  expect(failed.healthy).toBe(false);

  const noReviewer = evaluatePreviewStatus(staged("ready", "verified"), {
    healthy: { ok: true },
    accepted: { by: "", at: "2026-09-30T00:00:00.000Z" },
  });
  expect(noReviewer.stage).toBe("healthy");
  expect(noReviewer.accepted).toBe(false);

  const badTimestamp = evaluatePreviewStatus(staged("ready", "verified"), {
    healthy: { ok: true },
    accepted: { by: "reviewer", at: "not-a-date" },
  });
  expect(badTimestamp.accepted).toBe(false);

  const unhealthy = evaluatePreviewStatus(staged("ready", "verified"), {
    healthy: { ok: false },
    accepted: { by: "reviewer", at: "2026-09-30T00:00:00.000Z" },
  });
  expect(unhealthy.stage).toBe("isolated");
  expect(unhealthy.accepted).toBe(false);
});