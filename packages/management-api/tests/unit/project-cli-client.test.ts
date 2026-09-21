import { describe, expect, test } from "bun:test";
import {
  InvalidProjectCliReceiptError, ProjectCliClient, ProjectCliHttpError,
  readCliProject, requestProjectJson, type ProjectCliTransport,
} from "../../src/cli/project-client";

const project = {
  ref: "fixture-project", name: "Fixture", status: "ACTIVE_HEALTHY",
  region: "local", created_at: "2026-01-01T00:00:00.000Z",
  api: { url: "https://api.example.test" }, studio: { url: "https://studio.example.test" },
  database: { host: "db.example.test" },
};

function fixture(value: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const transport: ProjectCliTransport = {
    apiUrl: "http://127.0.0.1:9090", getToken: () => "synthetic-token",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return Response.json(value);
    },
  };
  return { calls, transport, client: new ProjectCliClient(transport) };
}

describe("project CLI JSON transport", () => {
  test.each([false, 0, "", null].map(body => ({ body })))("preserves falsey JSON %#", async ({ body }) => {
    const { transport, calls } = fixture({});
    await requestProjectJson(transport, "POST", "/v1/projects", body);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.body).toBe(JSON.stringify(body));
    expect(calls[0]?.init?.redirect).toBe("error");
  });
  test("omits only an absent body", async () => {
    const { transport, calls } = fixture({});
    await requestProjectJson(transport, "POST", "/v1/projects");
    expect(Object.hasOwn(calls[0]?.init ?? {}, "body")).toBe(false);
  });
  test.each([Symbol("invalid"), () => {}, 1n, { toJSON: () => undefined }, { toJSON: () => { throw new Error("private"); } }]
    .map(body => ({ body })))("rejects unsupported input before HTTP %#", async ({ body }) => {
    const { transport, calls } = fixture({});
    await expect(requestProjectJson(transport, "POST", "/v1/projects", body)).rejects.toThrow("not a JSON value");
    expect(calls).toEqual([]);
  });
  test("rejects cyclic JSON before HTTP", async () => {
    const body: Record<string, unknown> = {};
    body.self = body;
    const { transport, calls } = fixture({});
    await expect(requestProjectJson(transport, "POST", "/v1/projects", body)).rejects.toThrow("not a JSON value");
    expect(calls).toEqual([]);
  });
  test.each(["/v1/projects/../admin", "/v1/projects-other", "//other.invalid/v1/projects", "/v1/projects?key=x"])(
    "rejects ambiguous API path %s", async path => {
      const { transport, calls } = fixture({});
      await expect(requestProjectJson(transport, "GET", path)).rejects.toThrow("Invalid project API URL");
      expect(calls).toEqual([]);
    },
  );
  test.each([
    { timeoutMs: 0 }, { timeoutMs: NaN }, { maxResponseBytes: 0 }, { maxResponseBytes: Infinity },
  ])("validates transport budgets %#", async options => {
    const { transport, calls } = fixture({});
    await expect(requestProjectJson({ ...transport, ...options }, "GET", "/v1/projects")).rejects.toThrow("limits");
    expect(calls).toEqual([]);
  });
  test("error bodies cannot leak credentials into diagnostics", async () => {
    const { transport } = fixture({});
    transport.fetch = async () => new Response("private-credential", { status: 403 });
    await expect(requestProjectJson(transport, "GET", "/v1/projects")).rejects.toEqual(new ProjectCliHttpError(403));
  });
  test.each([
    () => new Response("not JSON", { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "9000" } }),
    () => Response.json({ value: "x".repeat(1024) }),
  ])("rejects invalid or oversized response %#", async response => {
    const { transport } = fixture({});
    transport.fetch = async () => response();
    transport.maxResponseBytes = 128;
    await expect(requestProjectJson(transport, "POST", "/v1/projects", {})).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
  });
  test("cancels a stalled body on deadline", async () => {
    const { transport } = fixture({});
    let cancelled = false;
    transport.timeoutMs = 20;
    transport.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
    await expect(requestProjectJson(transport, "GET", "/v1/projects")).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
    expect(cancelled).toBe(true);
  });
  test("settles even when an injected fetch ignores abort", async () => {
    const { transport } = fixture({});
    transport.timeoutMs = 20;
    transport.fetch = () => new Promise(() => {});
    await expect(requestProjectJson(transport, "GET", "/v1/projects")).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
  });
});

describe("project CLI response contracts", () => {
  test("creation requests and reads nested one-time credentials", async () => {
    const { client, calls } = fixture({
      ...project, credentials: { service_role_key: "synthetic-key".repeat(4) }, private_field: "hidden",
    });
    const result = await client.create({ name: project.name });
    expect(result.serviceRoleKey).toBe("synthetic-key".repeat(4));
    expect(result).not.toHaveProperty("private_field");
    expect(result).not.toHaveProperty("publishable_key");
    const serialized = calls[0]?.init?.body;
    if (typeof serialized !== "string") throw new Error("Missing create body");
    const body: unknown = JSON.parse(serialized);
    expect(body).toEqual({ name: project.name, credential_delivery: "response" });
  });
  test("mutating create arguments cannot change the expected receipt", async () => {
    const { client, calls } = fixture({ ...project, credentials: { service_role_key: "synthetic-key".repeat(4) } });
    const input = { name: project.name, region: "local" };
    const pending = client.create(input);
    input.name = "replacement";
    input.region = "other";
    expect((await pending).name).toBe(project.name);
    expect(calls[0]?.init?.body).toContain('"name":"Fixture"');
  });
  test.each([
    { ...project }, { ...project, credentials: { service_role_key: "********" } },
    { ...project, name: "other", credentials: { service_role_key: "synthetic-key".repeat(4) } },
  ])("rejects malformed create success without another POST %#", async value => {
    const { client, calls } = fixture(value);
    await expect(client.create({ name: project.name })).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
    expect(calls).toHaveLength(1);
  });
  test.each([null, [], {}, { ...project, ref: 1 }, { ...project, name: "\x1b[2J" },
    { ...project, api: null }, { ...project, database: [] }, { ...project, created_at: "invalid" },
    { ...project, api: { url: "javascript:alert(1)" } }, { ...project, api_url: "https://other.test" }]
    .map(value => ({ value })))("rejects malformed project receipt %#", ({ value }) => {
      expect(() => readCliProject(value)).toThrow(InvalidProjectCliReceiptError);
    });
  test("retains supported legacy flat URLs and absent list URLs", () => {
    expect(readCliProject({ ref: "p", name: "P", status: "COMING_UP" }).apiUrl).toBe("");
    expect(readCliProject({ ref: "p", name: "P", status: "COMING_UP", api_url: "https://api.test" }).apiUrl)
      .toBe("https://api.test");
  });
  test("lists only validated unique project records", async () => {
    expect((await fixture([project]).client.list())[0]?.ref).toBe(project.ref);
    await expect(fixture([project, project]).client.list()).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
    await expect(fixture([project, null]).client.list()).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
    expect(() => readCliProject({ ...project, ref: "another" }, project.ref)).toThrow(InvalidProjectCliReceiptError);
  });
  test("details use the actual public database host field", async () => {
    expect((await fixture(project).client.get(project.ref)).databaseHost).toBe("db.example.test");
    await expect(fixture({ ...project, database: {} }).client.get(project.ref)).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
  });
  test("path parameters cannot become other routes", async () => {
    const ref = "project/../other?token=value";
    const { client, calls } = fixture({ ...project, ref });
    await client.get(ref);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:9090/v1/projects/${encodeURIComponent(ref)}`);
    await expect(client.get("..")).rejects.toThrow("Invalid project ref");
    expect(calls).toHaveLength(1);
  });
  test("pause and restore receipts require matching identity and state", async () => {
    expect((await fixture({ ...project, status: "INACTIVE" }).client.transition(project.ref, "pause")).status).toBe("INACTIVE");
    expect((await fixture(project).client.transition(project.ref, "restore")).status).toBe("ACTIVE_HEALTHY");
    await expect(fixture(project).client.transition(project.ref, "pause")).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
    await expect(fixture({ ...project, ref: "another" }).client.delete(project.ref)).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
    await expect(fixture({ ref: "another", message: "done" }).client.restart(project.ref)).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
  });
  const keys = ["publishable", "secret", "anon", "service_role"].map(name => ({ name, api_key: name === "secret" ? "" : "masked" }));
  test("key lists preserve explicit absence and reject duplicate names", async () => {
    expect((await fixture(keys).client.keys(project.ref)).secret).toBe("");
    await expect(fixture([...keys.slice(0, 3), keys[0]]).client.keys(project.ref)).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
    await expect(fixture(keys.slice(0, 2)).client.keys(project.ref)).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
  });
  test("rotation receipts cannot fabricate missing keys", async () => {
    expect(await fixture({ anon_key: "anon", service_role_key: "********" }).client.rotateKeys(project.ref))
      .toEqual({ anon_key: "anon", service_role_key: "********" });
    await expect(fixture({ anon_key: "anon" }).client.rotateKeys(project.ref)).rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
    await expect(fixture({ publishable_key: "public", secret_key: "********" }).client.rotateOpaqueKeys(project.ref))
      .rejects.toBeInstanceOf(InvalidProjectCliReceiptError);
  });
});
