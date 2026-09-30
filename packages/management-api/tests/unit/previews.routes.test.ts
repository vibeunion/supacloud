import { expect, test } from "bun:test";
import { createPreviewRoutes } from "../../src/routes/previews";
import { derivePreviewBranchRef } from "../../src/services/preview-environment.service";

const app = createPreviewRoutes({ authorize: async () => undefined });
const body = { preview_ref: "pr-1", application_id: "reviews", environment_id: "preview",
  release_id: "a".repeat(64), source: { branch: "feature/orders", commit: "b".repeat(40) } };
function post(value: unknown, ref = "demo") {
  return new Request(`http://localhost/v1/projects/${ref}/previews/plan`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  });
}

test("composes a complete project-bound preview plan", async () => {
  const response = await app.handle(post(body));
  expect(response.status).toBe(200);
  const preview = await response.json();
  expect(preview.schema).toBe("supacloud.preview-environment.v1");
  expect(preview.branch_ref).toBe(derivePreviewBranchRef("demo", "pr-1"));
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

for (const type of ["project", "admin", "master", null] as const) {
  test(`full-clone planning uses verified principal ${type}, not caller authorization flag`, async () => {
    const routes = createPreviewRoutes({ authorize: async () => undefined,
      principal: async () => type ? { id: "verified-actor", type } : null });
    const response = await routes.handle(post({ ...body, data_mode: "full_clone", authorized_full_clone: true }));
    const privileged = type === "admin" || type === "master";
    expect(response.status).toBe(privileged ? 200 : 403);
    const payload = await response.json();
    if (privileged) expect(payload.data_mode).toBe("full_clone");
    else expect(payload.code).toBe("PREVIEW_ENVIRONMENT_FULL_CLONE_REQUIRES_AUTHORIZATION");
  });
}

test("project authorization failure prevents principal lookup and planning", async () => {
  let lookedUp = false;
  const routes = createPreviewRoutes({
    authorize: async () => ({ status: 403, body: { error: "Forbidden" } }),
    principal: async () => { lookedUp = true; return { id: "admin", type: "admin" }; },
  });
  expect((await routes.handle(post({ ...body, data_mode: "full_clone" }))).status).toBe(403);
  expect(lookedUp).toBe(false);
});
