import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationReleaseId, type ApplicationReleaseRecord } from "@supacloud/delivery";
import { validateExecutionPolicyCoverage } from "../execution-policy";
import type { HttpTransport } from "../transports/http";
import { APPLICATION_TOOL_SCHEMA, registerApplicationTools } from "./application-tools";
import { parseToolArguments } from "../schema";
import type { ReleaseControlToolResponse } from "./release-control-response";

function record(manifest = "a".repeat(64)): ApplicationReleaseRecord {
  return {
    schema: "supacloud.application-release.v1",
    project_ref: "project", application_id: "reviews",
    release_id: applicationReleaseId("project", "reviews", manifest),
    manifest_sha256: manifest, created_at: "2026-09-26T00:00:00.000Z",
    targets: [{ name: "api", object_id: "c".repeat(64), kind: "http", entrypoint: "bundle/index.js" }],
  };
}

function tool(data: unknown, overrides: Partial<HttpTransport> = {}) {
  let callback: ((args: Record<string, unknown>) => Promise<ReleaseControlToolResponse>) | undefined;
  registerApplicationTools({
    tool(name, _description, schema, handler) {
      validateExecutionPolicyCoverage({ [name]: { schema } });
      callback = handler;
    },
  }, { get: async () => ({ ok: true, status: 200, data }), ...overrides } as unknown as HttpTransport);
  if (!callback) throw new Error("Applications tool missing");
  return callback;
}

test("application schema is covered and a bound release is accepted", async () => {
  const release = record();
  const result = await tool({ project_ref: "project", application_id: "reviews", release })({
    action: "get_release", ref: "project", id: "reviews", release_id: release.release_id,
  });
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true, release });
});

test("delivery schemas validate through the CLI argument parser after the TypeBox upgrade", () => {
  const args = {
    action: "activate_release", ref: "project", id: "reviews", environment_id: "test",
    activation_id: "01234567-89ab-4def-8123-456789abcdef", release_id: "a".repeat(64),
    configuration_id: "11234567-89ab-4def-8123-456789abcdef", expected_activation_id: "absent",
  };
  expect(parseToolArguments(APPLICATION_TOOL_SCHEMA, args)).toEqual(args);
  for (const change of [
    { id: "../foreign" }, { release_id: "latest" }, { activation_id: "not-a-uuid" },
    { configuration_id: "current" }, { expected_activation_id: "current" }, { extra: true },
  ]) expect(() => parseToolArguments(APPLICATION_TOOL_SCHEMA, { ...args, ...change })).toThrow("Invalid arguments");
});

test("activation and reconciliation post once and validate bound receipts", async () => {
  const identity = {
    project_ref: "project", application_id: "reviews", environment_id: "test",
    release_id: record().release_id, activation_id: "01234567-89ab-4def-8123-456789abcdef",
  };
  for (const action of ["activate_release", "reconcile_activation"]) {
    for (const response of [
      { ok: true, status: 200, data: { ...identity, replayed: true } },
      { ok: true, status: 200, data: { ...identity, activation_id: "11234567-89ab-4def-8123-456789abcdef", replayed: true } },
      { ok: true, status: 200, data: { ...identity, environment_id: "wrong", replayed: true } },
      { ok: true, status: 200, data: {} },
      { ok: false, status: 0, transportError: true },
    ]) {
      let requests = 0;
      const configurationId = "21234567-89ab-4def-8123-456789abcdef";
      const handler = tool(null, { post: (async (url: string, body: unknown, options: unknown) => {
        requests++;
        const path = "/v1/projects/project/applications/reviews/environments/test/activations";
        expect(url).toBe(action === "activate_release" ? path : `${path}/${identity.activation_id}/reconcile`);
        expect(body).toEqual(action === "activate_release" ? {
          release_id: identity.release_id, activation_id: identity.activation_id,
          configuration_id: configurationId, expected_activation_id: null,
        } : {});
        expect(options).toEqual({ timeoutMs: 120_000, maxJsonBytes: 65_536, responseTimeoutMs: 30_000 });
        return response;
      }) as HttpTransport["post"] });
      const output = JSON.parse((await handler({
        action, ref: "project", id: "reviews", ...identity,
        configuration_id: configurationId, expected_activation_id: "absent",
      })).content[0]!.text);
      expect(requests).toBe(1);
      expect(output).toMatchObject(identity);
      if (response.data && "activation_id" in response.data && response.data.activation_id === identity.activation_id
        && response.data.environment_id === identity.environment_id) expect(output.ok).toBe(true);
      else expect(output.error.code).toBe("OUTCOME_UNKNOWN");
    }
  }
});

test("activation cannot infer the expected revision or accept mutable release/configuration aliases", async () => {
  let requests = 0;
  const handler = tool(null, { post: (async () => { requests++; throw new Error("Unexpected request"); }) as HttpTransport["post"] });
  const args = {
    action: "activate_release", ref: "project", id: "reviews", environment_id: "test",
    release_id: record().release_id, activation_id: "01234567-89ab-4def-8123-456789abcdef",
    configuration_id: "21234567-89ab-4def-8123-456789abcdef", expected_activation_id: null,
  };
  for (const change of [
    { expected_activation_id: undefined }, { configuration_id: "current" }, { release_id: "latest" }, { activation_id: undefined },
  ]) await expect(handler({ ...args, ...change })).rejects.toThrow();
  expect(requests).toBe(0);
});

test("retirement posts once, binds activation identity and does not require a release alias", async () => {
  const identity = {
    project_ref: "project", application_id: "reviews", environment_id: "test",
    activation_id: "01234567-89ab-4def-8123-456789abcdef",
  };
  for (const response of [
    { ok: true, status: 200, data: { ...identity, retired_at: "2026-09-26T00:00:00.000Z" } },
    { ok: true, status: 200, data: { ...identity, activation_id: "11234567-89ab-4def-8123-456789abcdef", retired_at: "2026-09-26T00:00:00.000Z" } },
    { ok: true, status: 200, data: {} },
    { ok: false, status: 0, transportError: true },
  ]) {
    let requests = 0;
    const handler = tool(null, { post: (async (url: string, body: unknown, options: unknown) => {
      requests++;
      expect(url).toBe(`/v1/projects/project/applications/reviews/environments/test/activations/${identity.activation_id}/retire`);
      expect(body).toEqual({});
      expect(options).toEqual({ timeoutMs: 120_000, maxJsonBytes: 65_536, responseTimeoutMs: 30_000 });
      return response;
    }) as HttpTransport["post"] });
    const output = JSON.parse((await handler({
      action: "retire_activation", ref: "project", id: "reviews", ...identity,
    })).content[0]!.text);
    expect(requests).toBe(1);
    expect(output.activation_id).toBe(identity.activation_id);
    if (response.data && "retired_at" in response.data && response.data.activation_id === identity.activation_id) {
      expect(output.ok).toBe(true);
    } else expect(output.error.code).toBe("OUTCOME_UNKNOWN");
  }
});

test("retirement rejects a release alias before issuing a mutation", async () => {
  let requests = 0;
  const handler = tool(null, { post: (async () => {
    requests++;
    return { ok: true, status: 200, data: {} };
  }) as HttpTransport["post"] });
  await expect(handler({
    action: "retire_activation", ref: "project", id: "reviews",
    environment_id: "test", activation_id: "01234567-89ab-4def-8123-456789abcdef",
    release_id: "a".repeat(64),
  })).rejects.toThrow("release_id is not accepted");
  expect(requests).toBe(0);
});

test("unmounted activation controls report HTTP errors without retry or outcome-unknown recovery", async () => {
  for (const action of ["activate_release", "reconcile_activation", "retire_activation"]) {
    let requests = 0;
    const handler = tool(null, { post: (async () => {
      requests++;
      return { ok: false, status: 404, data: {
        code: "APPLICATION_ROUTE_NOT_FOUND", error: "Application route not found",
      } };
    }) as HttpTransport["post"] });
    const result = await handler({
      action, ref: "project", id: "reviews", environment_id: "test",
      activation_id: "01234567-89ab-4def-8123-456789abcdef",
      ...(action === "retire_activation" ? {} : { release_id: record().release_id }),
      ...(action === "activate_release" ? {
        configuration_id: "21234567-89ab-4def-8123-456789abcdef", expected_activation_id: "absent",
      } : {}),
    });
    expect(requests).toBe(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      ok: false, operation: `applications.${action}`,
      activation_id: "01234567-89ab-4def-8123-456789abcdef",
      error: { code: "HTTP_ERROR", http_status: 404 },
    });
  }
});

function configurationView() {
  return {
    schema: "supacloud.application-configuration.v1", project_ref: "project", application_id: "reviews",
    environment_id: "test", configuration_id: "01234567-89ab-4def-8123-456789abcdef",
    created_at: "2026-09-26T00:00:00.000Z", bun_version: "1.4.2",
    targets: [{ name: "api", kind: "http", hosts: ["reviews.example.test"], environment_names: ["APP_SETTING"] }],
  };
}

test("configuration reads bind both envelope and revision and reject variable values in responses", async () => {
  const configuration = configurationView();
  const envelope = { project_ref: "project", application_id: "reviews", environment_id: "test", configuration };
  const args = { action: "get_configuration", ref: "project", id: "reviews", environment_id: "test" };
  expect(JSON.parse((await tool(envelope)(args)).content[0]!.text)).toMatchObject({ ok: true, configuration });
  expect(JSON.parse((await tool({ ...envelope, configuration: null })(args)).content[0]!.text))
    .toMatchObject({ ok: true, configuration: null });
  for (const value of [
    { ...configuration, environment_id: "wrong" },
    { ...configuration, targets: [{ ...configuration.targets[0], environment: { APP_SETTING: "private-fixture" } }] },
  ]) {
    expect(JSON.parse((await tool({ ...envelope, configuration: value })(args)).content[0]!.text))
      .toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  }
  expect(JSON.parse((await tool({ ...envelope, configuration: null })({
    ...args, configuration_id: configuration.configuration_id,
  })).content[0]!.text)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
});

test("configuration writes send the bounded file and retain revision identity on unknown outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "configuration-cli-"));
  try {
    const configuration = configurationView();
    const input = {
      configuration_id: configuration.configuration_id, expected_configuration_id: null,
      configuration: { bun_version: "1.4.2", targets: [
        { name: "api", kind: "http", hosts: ["reviews.example.test"], environment: { APP_SETTING: "private-fixture" } },
      ] },
    };
    const path = join(root, "configuration.json");
    await writeFile(path, JSON.stringify(input));
    const args = {
      action: "put_configuration", ref: "project", id: "reviews", environment_id: "test", configuration_path: path,
    };
    for (const response of [
      { ok: true, status: 200, data: { project_ref: "project", application_id: "reviews", environment_id: "test", configuration } },
      { ok: true, status: 200, data: {} },
      { ok: false, status: 0, transportError: true },
    ]) {
      let requests = 0;
      const handler = tool(null, { put: (async (url: string, body: unknown, options: unknown) => {
        requests++;
        expect(url).toBe("/v1/projects/project/applications/reviews/environments/test/configuration");
        expect(body).toEqual(input);
        expect(options).toEqual({ maxJsonBytes: 524_288, responseTimeoutMs: 30_000 });
        return response;
      }) as HttpTransport["put"] });
      const text = (await handler(args)).content[0]!.text;
      expect(requests).toBe(1);
      expect(text).not.toContain("private-fixture");
      const output = JSON.parse(text);
      expect(output.configuration_id).toBe(configuration.configuration_id);
      if (response.data && "configuration" in response.data) expect(output.ok).toBe(true);
      else expect(output.error.code).toBe("OUTCOME_UNKNOWN");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("application reads reject mismatched receipt identities", async () => {
  const release = record();
  const result = await tool({ project_ref: "project", application_id: "reviews", release })({
    action: "get_release", ref: "project", id: "reviews", release_id: "0".repeat(64),
  });
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
});

test("application inventory rejects duplicate, reversed and invalid cursor pages", async () => {
  const releases = [record(), record("b".repeat(64))].sort((a, b) => a.release_id.localeCompare(b.release_id));
  for (const page of [
    { releases: [releases[0], releases[0]], next_cursor: null },
    { releases: [...releases].reverse(), next_cursor: null },
    { releases, next_cursor: releases[0]!.release_id },
    { releases: [releases[0]], next_cursor: releases[0]!.release_id },
  ]) {
    const result = await tool({ project_ref: "project", application_id: "reviews", ...page })({
      action: "list_releases", ref: "project", id: "reviews", limit: 2,
    });
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  }
});

test("runtime reads preserve a non-ready report and reject a contradictory or foreign report", async () => {
  const activationId = "01234567-89ab-4def-8123-456789abcdef";
  const readiness = {
    project_ref: "project", application_id: "reviews", environment_id: "test",
    release_id: record().release_id, activation_id: activationId, ready: false,
    targets: [{
      target: "api", kind: "http",
      unit: `supacloud-application-project-${activationId}-api.service`,
      pid: 0, invocation_id: null, ready: false, code: "PROCESS_NOT_RUNNING",
    }],
  };
  const envelope = { project_ref: "project", application_id: "reviews", environment_id: "test", readiness };
  const args = { action: "get_runtime", ref: "project", id: "reviews", environment_id: "test" };
  expect(JSON.parse((await tool(envelope)(args)).content[0]!.text)).toMatchObject({
    ok: true, readiness: { ready: false },
  });
  for (const invalid of [{ ...readiness, ready: true }, { ...readiness, environment_id: "other" }]) {
    expect(JSON.parse((await tool({ ...envelope, readiness: invalid })(args)).content[0]!.text))
      .toMatchObject({ ok: false, error: { code: "INVALID_RESPONSE" } });
  }
  expect(JSON.parse((await tool({ ...envelope, readiness: null })(args)).content[0]!.text))
    .toMatchObject({ ok: true, readiness: null });
});
