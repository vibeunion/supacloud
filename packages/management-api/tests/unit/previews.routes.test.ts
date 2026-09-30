import { expect, test } from "bun:test";
import { createPreviewRoutes } from "../../src/routes/previews";

const app = createPreviewRoutes({ authorize: async () => undefined });
const body = {
  preview_ref: "pr-1",
  application_id: "reviews",
  environment_id: "preview",
  release_id: "a".repeat(64),
  source: { branch: "feature/orders", commit: "b".repeat(40) },
};
function post(value: unknown, path = "plan") {
  return new Request(`http://localhost/v1/projects/demo/previews/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
}

test("composes a complete preview environment plan", async () => {
  const response = await app.handle(post(body));
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.schema).toBe("supacloud.preview-environment.v1");
  expect(preview.branch_ref).toBe("preview-pr-1");
  expect(preview.components).toHaveLength(7);
  expect(preview.isolation).toHaveLength(4);
});

test("blocks production and invalid requests without echoing input", async () => {
  const production = await app.handle(post({ ...body, environment_id: "production" }));
  expect(production.status).toBe(403);
  expect((await production.json()).code).toBe("PREVIEW_ENVIRONMENT_PRODUCTION_FORBIDDEN");

  const invalid = await app.handle(post({ ...body, release_id: "short" }));
  expect(invalid.status).toBe(422);
  const payload = await invalid.json();
  expect(payload.code).toBe("PREVIEW_ENVIRONMENT_INVALID");
  expect(JSON.stringify(payload)).not.toContain("short");
});

test("fails closed when no isolation collector is configured", async () => {
  const response = await app.handle(post(body, "isolation-collection"));
  expect(response.status).toBe(501);
  expect((await response.json()).code).toBe("PREVIEW_ISOLATION_COLLECTOR_UNAVAILABLE");
});

test("collects isolation evidence from the injected collector", async () => {
  const collectedApp = createPreviewRoutes({
    authorize: async () => undefined,
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    isolationCollector: {
      collect: async (check) => check === "database_role"
        ? null
        : { ok: true, observed_at: "2026-09-30T11:00:00.000Z" },
    },
  });
  const response = await collectedApp.handle(post(body, "isolation-collection"));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.accepted).toBe(false);
  expect(payload.discarded).toEqual([{ check: "database_role", reason: "no observation" }]);
  expect(payload.isolation.map((check: { status: string }) => check.status)).toEqual(["pending", "verified", "verified", "verified"]);
  expect(payload.status.isolated).toBe(false);
});

test("evaluates isolation evidence and gates acceptance", async () => {
  const pending = await app.handle(post(body, "acceptance"));
  const pendingPayload = await pending.json();
  expect(pendingPayload.accepted).toBe(false);
  expect(pendingPayload.status.stage).toBe("planned");
  expect(pendingPayload.status.accepted).toBe(false);

  const accepted = await app.handle(post({
    ...body,
    evidence: {
      database_role: { ok: true }, storage_permissions: { ok: true },
      consumer_identity: { ok: true }, route_access_control: { ok: true },
    },
  }, "acceptance"));
  const evaluation = await accepted.json();
  expect(evaluation.accepted).toBe(true);
  expect(evaluation.isolation.every((check: { status: string }) => check.status === "verified")).toBe(true);
  // Isolation is verified, but the composed plan is not provisioned, so the
  // reported stage must not claim health or acceptance.
  expect(evaluation.status.isolated).toBe(false);
  expect(evaluation.status.stage).toBe("planned");
});