import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApplicationRoutes } from "../../src/routes/applications";
import { ApplicationActiveStorage } from "../../src/services/application-active-storage";
import { ApplicationReadiness } from "../../src/services/application-readiness";
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
