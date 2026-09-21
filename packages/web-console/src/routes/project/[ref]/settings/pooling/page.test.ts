import { describe, expect, spyOn, test } from "bun:test";
import type { BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseProjectPoolingState, loadProjectPoolingState } from "../../../../../lib/project-pooling";
import { poolingFixture } from "../../../../../lib/project-pooling.test-fixtures";
import { buildProjectPoolingState } from "../../../../../../../management-api/src/services/project-pooling-state";
import type { ProjectDetailResponse } from "../../../../../../../management-api/src/services/project.service";

describe("project pooling configuration boundary", () => {
  test("uses declared endpoints and project identities, retaining absent settings and numeric zero", () => {
    const unknown = parseProjectPoolingState(poolingFixture(), "a");
    expect(unknown.poolMode).toBeNull();
    expect(unknown.poolSize).toBeNull();
    expect(unknown.connectionString).toBe("postgresql://user_a:[YOUR-PASSWORD]@pool.example.test:6644/db_a?pgbouncer=true");
    expect(unknown.directString).toBe("postgresql://user_a:[YOUR-PASSWORD]@db.example.test:5544/db_a");
    const configured = parseProjectPoolingState(poolingFixture("a", {
      pgbouncer: { pool_mode: "statement", default_pool_size: "0" },
    }), "a");
    expect(configured.poolMode).toBe("statement");
    expect(configured.poolSize).toBe(0);
  });

  test("encodes database identifiers and preserves IPv6 authorities without injecting URI parameters", () => {
    const state = buildProjectPoolingState({
      ref: "a", config: {}, database: { host: "::1", name: "database/?sslmode=disable", user: "user@:/" },
    }, { pgPort: 5544, poolerHost: "[::1]", poolerPort: 6644 });
    const decoded = parseProjectPoolingState(state, "a");
    expect(decoded.connectionString).toBe(
      "postgresql://user%40%3A%2F:[YOUR-PASSWORD]@[::1]:6644/database%2F%3Fsslmode%3Ddisable?pgbouncer=true",
    );
    expect(decoded.directString).toContain("@[::1]:5544/");
  });

  test("rejects conflicting aliases, malformed saved settings and invalid declared endpoints", () => {
    const database = { host: "db.example.test", name: "db_a", user: "user_a" };
    const runtime = { pgPort: 5544, poolerHost: "pool.example.test", poolerPort: 6644 };
    for (const config of [
      null, [], { pgbouncer: null }, { pooler: "invalid" },
      { pgbouncer_pool_mode: "invalid" }, { pgbouncer_default_pool_size: -1 },
      { pgbouncer_default_pool_size: "1.2" }, { pgbouncer_default_pool_size: "9007199254740992" },
      { pgbouncer: { default_pool_size: true } },
      { pgbouncer_pool_mode: "session", pooler: { pool_mode: "transaction" } },
      { pgbouncer_default_pool_size: 1, pgbouncer: { default_pool_size: 2 } },
    ]) expect(() => buildProjectPoolingState({ ref: "a", config, database }, runtime)).toThrow();
    for (const host of ["", "user@evil.test", "evil.test/path", "evil.test:6644", "evil.test?x", "db\nhost", "\\evil.test", "https://db.test"]) {
      expect(() => buildProjectPoolingState({ ref: "a", config: {}, database }, { ...runtime, poolerHost: host })).toThrow();
    }
    for (const port of [0, -1, 65536, NaN, 1.5, "6644"]) {
      expect(() => buildProjectPoolingState({ ref: "a", config: {}, database }, { ...runtime, poolerPort: port })).toThrow();
    }
  });

  test("does not accept missing, cross-project, ambiguous or credential-bearing response data", () => {
    const valid = poolingFixture();
    for (const input of [
      null, [], {}, { ...valid, project_ref: "other" }, { ...valid, source: "live" },
      { ...valid, database: {} }, { ...valid, database: { ...valid.database, name: "\0" } },
      { ...valid, pooler: { host: "user:password@evil.test", port: 6644 } },
      { ...valid, pooler: { host: "pool.example.test:6644", port: 6644 } },
      { ...valid, pooler: { ...valid.pooler, port: "6644" } },
      { ...valid, direct: null }, { ...valid, settings: {} },
      { ...valid, settings: { pool_mode: false, default_pool_size: 1 } },
      { ...valid, settings: { pool_mode: "session", default_pool_size: true } },
    ]) expect(() => parseProjectPoolingState(input, "a")).toThrow();
    expect(() => parseProjectPoolingState(valid, "../other")).toThrow();
  });

  test("bounds reads and rejects invalid project paths before transport", async () => {
    let reads = 0;
    const request = async (url: string, options: RequestInit) => {
      reads++;
      expect(url).toBe("/v1/projects/a/pooling-state");
      expect(options.cache).toBe("no-store");
      expect(options.redirect).toBe("error");
      return Response.json(poolingFixture());
    };
    expect(() => loadProjectPoolingState("../a", request, new AbortController().signal)).toThrow();
    expect(reads).toBe(0);
    const state = await loadProjectPoolingState("a", request, new AbortController().signal);
    expect(state.projectRef).toBe("a");
    await expect(loadProjectPoolingState("a", async () => new Response("x".repeat(65 * 1024)),
      new AbortController().signal)).rejects.toThrow();
    await expect(loadProjectPoolingState("a", async () => Response.json(poolingFixture(), { status: 503 }),
      new AbortController().signal)).rejects.toThrow();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(loadProjectPoolingState("a", request, cancelled.signal)).rejects.toThrow();
    expect(reads).toBe(1);
  });
});

test("actual pooling route authorizes reads and produces the Console contract without invented settings", async () => {
  const { Elysia } = await import("../../../../../../../management-api/node_modules/elysia");
  const { projectConfigRoutes } = await import("../../../../../../../management-api/src/routes/project-config");
  const { projectService } = await import("../../../../../../../management-api/src/services");
  const { config } = await import("../../../../../../../management-api/src/config");
  const original = { pgPort: config.pgPort, poolerHost: config.poolerHost, poolerPort: config.poolerPort, masterToken: config.masterToken };
  Object.assign(config, { pgPort: 5544, poolerHost: "pool.example.test", poolerPort: 6644, masterToken: "pooling-test-master-token" });
  const project: ProjectDetailResponse = {
    id: "a", ref: "a", name: "Project A", status: "active", region: "local", organization_id: "default",
    created_at: new Date(), updated_at: new Date(), config: {},
    database: { host: "db.example.test", name: "db_a", user: "user_a" },
    api: { url: "https://api.example.test" }, studio: { url: "https://studio.example.test" },
  };
  const lookup = spyOn(projectService, "getProject").mockResolvedValue(project);
  const app = new Elysia().use(projectConfigRoutes);
  const request = (authorized = true) => app.handle(new Request("http://localhost/v1/projects/a/pooling-state", {
    headers: authorized ? { Authorization: "Bearer pooling-test-master-token" } : {},
  }));
  try {
    const denied = await request(false);
    expect(denied.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    const response = await request();
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(parseProjectPoolingState(body, "a")).toEqual(parseProjectPoolingState(poolingFixture(), "a"));
    lookup.mockResolvedValue({ ...project, ref: "foreign" });
    expect((await request()).status).toBe(503);
    lookup.mockResolvedValue({ ...project, config: { pgbouncer_default_pool_size: "private invalid value" } });
    const invalid = await request();
    expect(invalid.status).toBe(503);
    expect(await invalid.text()).not.toContain("private invalid value");
    lookup.mockResolvedValue(null);
    expect((await request()).status).toBe(404);
  } finally {
    lookup.mockRestore();
    Object.assign(config, original);
  }
});

const localFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));
function compiler(): BunPlugin {
  const typescript = new Bun.Transpiler({ loader: "ts" });
  return {
    name: "project-pooling-tests",
    setup(builder) {
      builder.onResolve({ filter: /^(\$app\/state|svelte-sonner)$/ },
        () => ({ path: localFile("page.test-fixture.svelte.ts") }));
      builder.onResolve({ filter: /^\$lib\/(api|project-pooling)$/ },
        ({ path }) => ({ path: localFile(`../../../../../lib/${path.slice("$lib/".length)}.ts`) }));
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await preprocess(await Bun.file(path).text(), vitePreprocess(), { filename: path });
        return { contents: compile(source.code, { filename: path, generate: "client", css: "injected" }).js.code, loader: "js" };
      });
      builder.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        return { contents: compileModule(path.endsWith(".ts") ? typescript.transformSync(source) : source,
          { filename: path, generate: "client" }).js.code, loader: "js" };
      });
    },
  };
}

test("compiled pooling page clears invalid and stale state and scopes clipboard operations", async () => {
  if (process.env.SUPACLOUD_POOLING_TEST !== "1") {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      env: { ...process.env, SUPACLOUD_POOLING_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://wrong-browser-host.test/" });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element, Node: window.Node, Text: window.Text, Comment: window.Comment,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window), MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  const bundlePath = join(tmpdir(), `supacloud-pooling-${crypto.randomUUID()}.mjs`);
  try {
    const result = await Bun.build({
      entrypoints: [localFile("page.test-entry.ts")], target: "browser", format: "esm",
      conditions: ["svelte", "browser"], external: ["node:assert"], plugins: [compiler()],
    });
    if (!result.success) throw new AggregateError(result.logs, "Pooling fixture build failed");
    const output = result.outputs[0];
    if (!output) throw new Error("Missing pooling fixture bundle");
    await Bun.write(bundlePath, output);
    await import(pathToFileURL(bundlePath).href);
  } finally {
    await rm(bundlePath, { force: true });
    dom.window.close();
  }
}, 30_000);
