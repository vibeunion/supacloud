import { expect, test } from "bun:test";
import { loadHostingDetail, parseHostingDetail } from "./hosting-detail";
import { hostingDeployment } from "./hosting-list.test-fixtures";
import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";

function detail() {
  return {
    ...hostingDeployment(), build_command: "", output_dir: ".", install_command: "",
    node_version: "20", env_vars: { TOKEN: "********" }, env_revision: "enc:v1:detailFixture",
    configuration_revision: "enc:v1:configurationFixture",
  };
}

test("hosting detail preserves validated editable data and drops unrelated metadata", () => {
  const source = detail();
  const result = parseHostingDetail({ ...source, deploy_tokens: [{ token: "secret" }], build_log: "secret" }, "a", "dep-a");
  expect(result).toEqual({ ...source, health_check_path: "/" });
  source.env_vars.TOKEN = "changed";
  expect(result.env_vars.TOKEN).toBe("********");
  expect(parseHostingDetail({ ...detail(), build_command: "npm run check\nnpm run build" }, "a", "dep-a").build_command)
    .toBe("npm run check\nnpm run build");
});

test("hosting detail rejects invalid identity, configuration and exposed environment values", () => {
  for (const change of [
    { id: "dep-b" }, { project_ref: "b" }, { build_command: 1 }, { build_command: null },
    { output_dir: {} }, { install_command: false }, { node_version: [] },
    { health_check_path: null }, { env_vars: null }, { env_vars: { TOKEN: "plaintext-secret" } },
    { env_vars: { "bad-key": "********" } }, { deployment_url: "javascript:alert(1)" },
    { build_command: "x".repeat(16_385) },
    { env_revision: undefined }, { env_revision: null }, { env_revision: "invalid" },
    { configuration_revision: undefined }, { configuration_revision: null }, { configuration_revision: "invalid" },
  ]) expect(() => parseHostingDetail({ ...detail(), ...change }, "a", "dep-a")).toThrow("Invalid hosting detail response");
  let reads = 0;
  const source = Object.defineProperty(detail(), "build_command", {
    get() { reads++; return "build"; }, enumerable: true,
  });
  expect(() => parseHostingDetail(source, "a", "dep-a")).toThrow();
  expect(reads).toBe(0);
});

test("hosting detail binds request scope and distinguishes an actual missing deployment", async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const request = async (url: string, options: RequestInit) => {
    calls++;
    expect(url).toBe("/v1/projects/a/frontend/deployments/dep-a");
    expect(options.cache).toBe("no-store");
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    return Response.json(detail());
  };
  await expect(loadHostingDetail("../a", "dep-a", request, signal)).rejects.toThrow();
  await expect(loadHostingDetail("a", "../dep-a", request, signal)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(await loadHostingDetail("a", "dep-a", request, signal)).toEqual({ ...detail(), health_check_path: "/" });
  expect(calls).toBe(1);
  expect(await loadHostingDetail("a", "dep-a", async () => Response.json({
    code: "404", message: "Deployment not found",
  }, { status: 404 }), signal)).toBeNull();
  for (const response of [
    Response.json({}, { status: 404 }), Response.json(detail(), { status: 500 }),
    Response.json(detail(), { status: 201 }), Response.json({ ...detail(), id: "other" }),
    new Response("{}", { headers: { "content-length": String(1024 * 1024 + 1) } }),
  ]) await expect(loadHostingDetail("a", "dep-a", async () => response, signal)).rejects.toThrow();
});

test("hosting detail cancellation stops reads without publishing a missing deployment", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const started = Promise.withResolvers<void>();
  const pending = loadHostingDetail("a", "dep-a", async () => {
    started.resolve();
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  }, controller.signal);
  await started.promise;
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("hosting detail page compiles with the typed read boundary", () => {
  const filename = new URL("../routes/project/[ref]/hosting/[id]/+page.svelte", import.meta.url);
  const source = readFileSync(filename, "utf8");
  expect(() => compile(source, { filename: filename.pathname, generate: "client" })).not.toThrow();
  expect(source).toContain("loadHostingDetail(ref, id, apiClient, signal)");
  expect(source).not.toContain("String(d.build_command");
  expect(source).not.toContain("as string[] as domain");
});
