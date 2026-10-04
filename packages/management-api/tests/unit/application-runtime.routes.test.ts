import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplicationRoutes } from "../../src/routes/applications";
import { ApplicationActiveStorage } from "../../src/services/application-active-storage";
import { ApplicationReadiness } from "../../src/services/application-readiness";
import { ApplicationDeploymentEvidenceStorage } from "../../src/services/application-deployment-evidence";
import { runtimeInput } from "../helpers/application-runtime";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "runtime-read-route-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const url = "http://localhost/v1/projects/demo/applications/reviews/environments/test/runtime";
const headers = { authorization: "Bearer local-runtime-test" };

test("runtime read requires project access and absent authority does not create state", async () => {
  const active = new ApplicationActiveStorage(join(root, "authority"));
  let probes = 0;
  const app = createApplicationRoutes({
    active, projectExists: async () => true,
    authorize: async request => request.headers.get("authorization") === headers.authorization
      ? undefined : { status: 401, body: { error: "Unauthorized" } },
    readiness: { inspect: async () => { probes++; throw new Error("Unexpected probe"); } },
  });
  expect((await app.handle(new Request(url))).status).toBe(401);
  const response = await app.handle(new Request(url, { headers }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    project_ref: "demo", application_id: "reviews", environment_id: "test", readiness: null,
  });
  expect(probes).toBe(0);
  expect(await readdir(root)).toEqual([]);
});

test("runtime read returns environment-bound non-ready feedback without exposing configuration", async () => {
  const active = new ApplicationActiveStorage(join(root, "authority"));
  await active.write({
    schema: "supacloud.application-active.v1", runtime: runtimeInput(), configurationDigest: "d".repeat(64),
    configurationId: "91234567-89ab-4def-8123-456789abcdef",
  }, null);
  const app = createApplicationRoutes({
    active, projectExists: async () => true, authorize: async () => undefined,
    readiness: new ApplicationReadiness({ observe: async () => [] }),
  });
  const response = await app.handle(new Request(url, { headers }));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.configuration_id).toBe("91234567-89ab-4def-8123-456789abcdef");
  expect(body.readiness).toMatchObject({
    environment_id: "test", activation_id: runtimeInput().activationId, ready: false,
  });
  expect(JSON.stringify(body)).not.toContain("configurationDigest");
});

test("an activation changed during observation is not reported as the current runtime", async () => {
  const active = new ApplicationActiveStorage(join(root, "authority"));
  const original = { schema: "supacloud.application-active.v1" as const, runtime: runtimeInput(), configurationDigest: "d".repeat(64) };
  await active.write(original, null);
  const app = createApplicationRoutes({
    active, projectExists: async () => true, authorize: async () => undefined,
    readiness: { inspect: async input => {
      const next = structuredClone(original);
      next.runtime.activationId = "11234567-89ab-4def-8123-456789abcdef";
      await active.write(next, original.runtime.activationId);
      return new ApplicationReadiness({ observe: async () => [] }).inspect(input);
    } },
  });
  const response = await app.handle(new Request(url, { headers }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "APPLICATION_RUNTIME_CHANGED" });
});

test("deployment evidence is persisted, read back and scope-bound", async () => {
  const evidence = new ApplicationDeploymentEvidenceStorage(join(root, "evidence"));
  const value = {
    schema: "supacloud.deployment-evidence.v1" as const,
    status: "unknown" as const,
    recorded_at: "2026-10-04T00:00:00.000Z",
    scope: { project_ref: "demo", application_id: "reviews", environment_id: "test" },
    source: {
      commit_sha: "abcdef1234567", manifest_sha256: "a".repeat(64),
      contract_schema: null, environment_binding_version: null,
    },
    database: {
      provider: "postgresql", version: "18.0", topology: "single-node" as const,
      migration: { status: "confirmed" as const, inventory_sha256: "a".repeat(64), compatibility: "verified" as const },
      backup: { status: "unknown" as const, latest_success_at: null, freshness_seconds: null },
      recovery: { status: "unknown" as const, drill_id: null, rpo_seconds: null, rto_seconds: null },
    },
    components: [{
      name: "management-api" as const, version: "0.90.1", status: "confirmed" as const,
      health_check: "/health", checked_at: "2026-10-04T00:00:00.000Z",
    }],
    activation: {
      release_id: "b".repeat(64), configuration_id: "01234567-89ab-4def-8123-456789abcdef",
      activation_id: "01234567-89ab-4def-8123-456789abcdef",
    },
    health: { status: "confirmed" as const, checked_at: "2026-10-04T00:00:00.000Z", authenticated_smoke: "confirmed" as const },
    rollback: { release_id: null, configuration_id: null, status: "unknown" as const, result: null },
    notes: [],
  };
  const app = createApplicationRoutes({
    evidence, projectExists: async () => true, authorize: async () => undefined,
  });
  const endpoint = "http://localhost/v1/projects/demo/applications/reviews/environments/test/deployment-evidence";
  const write = await app.handle(new Request(endpoint, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
  }));
  expect(write.status).toBe(200);
  expect(await write.json()).toMatchObject({ evidence: { status: "unknown" } });
  const read = await app.handle(new Request(endpoint));
  expect(read.status).toBe(200);
  expect(await read.json()).toMatchObject({ evidence: value });
  const mismatch = await app.handle(new Request(
    "http://localhost/v1/projects/demo/applications/other/environments/test/deployment-evidence",
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(value) },
  ));
  expect(mismatch.status).toBe(409);
});
