import { expect, test } from "bun:test";
import { createPreviewRoutes } from "../../src/routes/previews";

const app = createPreviewRoutes({ authorize: async () => undefined });
const body = { preview_ref: "pr-1", application_id: "reviews", environment_id: "preview",
  release_id: "a".repeat(64), source: { branch: "feature/orders", commit: "b".repeat(40) } };
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

test("collects bounded evidence from the injected collector, preserving pending checks", async () => {
  const routes = createPreviewRoutes({ authorize: async () => undefined,
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    isolationCollector: { collect: async (check, selected) => check === "database_role" ? null : {
      ok: true, collector: "platform-test-probe", check,
      project_ref: selected.project_ref, application_id: selected.application_id,
      environment_id: selected.environment_id, branch_ref: selected.branch_ref,
      preview_ref: selected.preview_ref, release_id: selected.release_id,
      configuration_id: selected.configuration_id ?? null,
      observed_at: "2026-09-30T11:00:00.000Z", expires_at: "2026-09-30T13:00:00.000Z",
    } },
  });
  const response = await routes.handle(post(body, "isolation-collection"));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.accepted).toBe(false);
  expect(payload.evidence_source).toBe("trusted-collector");
  expect(payload.discarded).toEqual([{ check: "database_role", reason: "no observation" }]);
  expect(payload.isolation.map((check: { status: string }) => check.status)).toEqual(["pending", "verified", "verified", "verified"]);
  expect(payload.status.isolated).toBe(false);
});

test("caller evidence, health and signoff never certify isolation or acceptance", async () => {
  for (const value of [body, { ...body,
    evidence: { database_role: { ok: true }, storage_permissions: { ok: true }, consumer_identity: { ok: true }, route_access_control: { ok: true } },
    healthy: { ok: true }, accepted: { by: "forged-admin", at: "2026-09-30T12:00:00.000Z" },
  }]) {
    const response = await app.handle(post(value, "acceptance"));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.accepted).toBe(false);
    expect(payload.evidence_source).toBe("caller-unverified");
    expect(payload.isolation.every((check: { status: string }) => check.status === "pending")).toBe(true);
    expect(payload.status.stage).toBe("planned");
    expect(payload.status.accepted).toBe(false);
    expect(JSON.stringify(payload)).not.toContain("forged-admin");
  }
});

for (const path of ["plan", "acceptance", "isolation-collection"]) {
  test(`${path} rejects self-authorized full clone for a project principal`, async () => {
    const routes = createPreviewRoutes({ authorize: async () => undefined,
      principal: async () => ({ id: "project-actor", type: "project" }),
    });
    const response = await routes.handle(post({ ...body, data_mode: "full_clone", authorized_full_clone: true }, path));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("PREVIEW_ENVIRONMENT_FULL_CLONE_REQUIRES_AUTHORIZATION");
  });
}
for (const type of ["admin", "master"] as const) {
  test(`verified ${type} may compose a full clone plan, not execute it`, async () => {
    const routes = createPreviewRoutes({ authorize: async () => undefined, principal: async () => ({ id: "verified-actor", type }) });
    const response = await routes.handle(post({ ...body, data_mode: "full_clone", authorized_full_clone: false }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data_mode).toBe("full_clone");
    expect(payload.components.every((component: { status: string }) => component.status === "planned")).toBe(true);
  });
}

test("authorization denial prevents principal lookup and collection", async () => {
  let calls = 0;
  const routes = createPreviewRoutes({ authorize: async () => ({ status: 403, body: { error: "Forbidden" } }),
    principal: async () => { calls++; return { id: "admin", type: "admin" }; },
    isolationCollector: { collect: async () => { calls++; return null; } },
  });
  expect((await routes.handle(post({ ...body, data_mode: "full_clone" }, "isolation-collection"))).status).toBe(403);
  expect(calls).toBe(0);
});
