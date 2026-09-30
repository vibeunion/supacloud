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
function post(value: unknown) {
  return new Request("http://localhost/v1/projects/demo/previews/plan", {
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