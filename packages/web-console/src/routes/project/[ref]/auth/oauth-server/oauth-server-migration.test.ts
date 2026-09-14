import { expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, compileModule, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseOAuthServerStatus, readOAuthServer, migrateOAuthServerWithReadback } from "./oauth-server-migration";
import { oauthStatus, partialFailure } from "./oauth-server.test-fixtures";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected test object");
  return Object.fromEntries(Object.entries(value));
}
test("status decoder binds the project and validates all published configuration endpoints and flags", () => {
  const status = parseOAuthServerStatus(oauthStatus(), "a");
  expect(status.project_ref).toBe("a");
  expect(status.state_source).toBe("configuration");
  expect(status.runtime_verified).toBe(false);
  for (const value of [null, [], {}, { data: oauthStatus() },
    ...[
      { project_ref: "b" }, { account_isolated: false }, { state_source: "runtime" },
      { runtime_verified: true }, { organization_id: 5 }, { enabled: "true" },
      { allow_dynamic_registration: null }, { issuer: "javascript:alert(1)" },
      { authorization_path: "//foreign.test" }, { authorization_path: "/%2e%2e/secret" },
      { discovery_url: "https://foreign.test" }, { oauth_authorization_server_metadata_url: "https://user:secret@auth.test" },
      { jwks_url: "https://foreign.test" }, { authorization_endpoint: "https://foreign.test" },
      { token_endpoint: "https://foreign.test" }, { userinfo_endpoint: "https://foreign.test" },
      { registration_endpoint: "https://foreign.test" }, { signing_alg: "HS256" },
      { oidc_id_token_ready: false }, { migration_status: "not_migrated" }, { key_id: null },
      { warnings: ["valid", 1] },
    ].map(patch => ({ ...oauthStatus(), ...patch })),
  ]) expect(() => parseOAuthServerStatus(value, "a")).toThrow();
  const unmigrated = { ...oauthStatus(), signing_alg: "not_migrated", migration_status: "not_migrated", oidc_id_token_ready: false };
  const { key_id: _key, ...withoutKey } = unmigrated;
  expect(parseOAuthServerStatus(withoutKey, "a").key_id).toBeNull();
  const rs = { ...oauthStatus(), signing_alg: "RS256", migration_status: "oidc_rs256_migrated" };
  expect(parseOAuthServerStatus(rs, "a").signing_alg).toBe("RS256");
});

test("migration matches captured submitted settings and retains dependent failure after one readback", async () => {
  for (const outcome of ["applied", "dependent_refresh_failed"] as const) {
    const calls: string[] = [];
    const result = await migrateOAuthServerWithReadback(parseOAuthServerStatus(oauthStatus(), "a"), true,
      async (url, options) => {
        calls.push(url);
        expect(options.redirect).toBe("error");
        expect(options.cache).toBe("no-store");
        if (url.endsWith("/migrate")) {
          expect(options.body).toBe(JSON.stringify({ allow_dynamic_registration: true }));
          if (outcome === "dependent_refresh_failed") return Response.json(partialFailure(), { status: 503 });
        }
        return Response.json({ ...oauthStatus(), allow_dynamic_registration: true });
      }, new AbortController().signal);
    expect(result.outcome).toBe(outcome);
    expect(result.status.allow_dynamic_registration).toBe(true);
    expect(calls).toEqual(outcome === "applied" ? ["/v1/projects/a/auth/oauth-server/migrate"]
      : ["/v1/projects/a/auth/oauth-server/migrate", "/v1/projects/a/auth/oauth-server"]);
  }
  const pending = Promise.withResolvers<Response>();
  const before = parseOAuthServerStatus(oauthStatus(), "a");
  const migration = migrateOAuthServerWithReadback(before, false, async () => pending.promise, new AbortController().signal);
  before.project_ref = "b";
  before.issuer = "https://b.example.test/auth/v1";
  pending.resolve(Response.json(oauthStatus()));
  expect((await migration).status.project_ref).toBe("a");
});

test("migration rejects ordinary failures and contradictory, foreign or unmatched receipts without retry", async () => {
  for (const failure of [
    { code: "AUTH_RUNTIME_APPLY_FAILED", message: "private backend message" },
    { ...partialFailure(), authority_project_ref: "b" }, { ...partialFailure(), runtime_mode: "shared" },
    { ...partialFailure(), persisted: false }, { ...partialFailure(), runtime_applied: false },
    { ...partialFailure(), dependents_applied: true }, { ...partialFailure(), failed_dependents: [] },
    { ...partialFailure(), failed_dependents: ["a"] },
  ]) {
    let calls = 0;
    await expect(migrateOAuthServerWithReadback(parseOAuthServerStatus(oauthStatus(), "a"), false, async () => {
      calls++;
      return Response.json(failure, { status: 503 });
    }, new AbortController().signal)).rejects.toThrow("Invalid");
    expect(calls).toBe(1);
  }
  for (const patch of [
    { enabled: false }, { allow_dynamic_registration: true }, { project_ref: "b" },
    { organization_id: "other" }, { authorization_path: "/different" }, { key_id: "changed-key" },
    { signing_alg: "RS256", migration_status: "oidc_rs256_migrated" },
  ]) await expect(migrateOAuthServerWithReadback(parseOAuthServerStatus(oauthStatus(), "a"), false,
    async () => Response.json({ ...oauthStatus(), ...patch }), new AbortController().signal)).rejects.toThrow();
});

test("status and migration transport reject oversized responses and cancellation prevents readback", async () => {
  let calls = 0;
  const stopped = new AbortController();
  stopped.abort();
  await expect(readOAuthServer("a", async () => { calls++; return Response.json(oauthStatus()); }, stopped.signal)).rejects.toThrow();
  expect(calls).toBe(0);
  expect(() => readOAuthServer("../a", async () => Response.json(oauthStatus()), new AbortController().signal)).toThrow();
  await expect(readOAuthServer("a", async () => new Response("x".repeat(32 * 1024 + 1)),
    new AbortController().signal)).rejects.toThrow();
  const cancel = new AbortController();
  await expect(migrateOAuthServerWithReadback(parseOAuthServerStatus(oauthStatus(), "a"), false,
    async () => {
      calls++;
      cancel.abort();
      return Response.json(partialFailure(), { status: 503 });
    }, cancel.signal)).rejects.toThrow();
  expect(calls).toBe(1);
});

const localFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));
function compiler(sdkDirectory: string): BunPlugin {
  const typescript = new Bun.Transpiler({ loader: "ts" });
  return {
    name: "oauth-console-tests",
    setup(builder) {
      builder.onResolve({ filter: /^(\$app\/state|svelte-sonner|svelte-i18n)$/ }, () => ({ path: localFile("page.test-fixture.svelte.ts") }));
      builder.onResolve({ filter: /^\$lib\/api$/ }, () => ({ path: localFile("../../../../../lib/api.ts") }));
      builder.onResolve({ filter: /^\$supacloud\/oauth-clients$/ }, () => ({ path: join(sdkDirectory, "oauth-clients.ts") }));
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await preprocess(await Bun.file(path).text(), vitePreprocess(), { filename: path });
        return { contents: compile(source.code, { filename: path, generate: "client", css: "injected" }).js.code, loader: "js" };
      });
      builder.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) => ({
        contents: compileModule(typescript.transformSync(await Bun.file(path).text()), { filename: path, generate: "client" }).js.code,
        loader: "js",
      }));
    },
  };
}
test("compiled OAuth page isolates reads, mutations, partial outcomes and one-time secrets", async () => {
  if (process.env.SUPACLOUD_OAUTH_PAGE_TEST !== "1") {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url), "--test-name-pattern", "compiled OAuth page"],
      env: { ...process.env, SUPACLOUD_OAUTH_PAGE_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    return;
  }
  const configFile = localFile("../../../../../../svelte.config.js");
  const config: unknown = (await import(pathToFileURL(configFile).href)).default;
  const alias = record(record(record(config).kit).alias).$supacloud;
  if (typeof alias !== "string") throw new Error("Missing production SDK source alias");
  const sdkDirectory = resolve(dirname(configFile), alias);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement, HTMLSelectElement: window.HTMLSelectElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLFieldSetElement: window.HTMLFieldSetElement,
    Element: window.Element, Node: window.Node, Text: window.Text, Comment: window.Comment,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window), MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    confirm: () => true,
  });
  const bundlePath = join(tmpdir(), `supacloud-oauth-page-${crypto.randomUUID()}.mjs`);
  try {
    const result = await Bun.build({
      entrypoints: [localFile("page.test-entry.ts")], target: "browser", format: "esm",
      conditions: ["svelte", "browser"], external: ["node:assert"], plugins: [compiler(sdkDirectory)],
    });
    if (!result.success) throw new AggregateError(result.logs, "OAuth page fixture build failed");
    const output = result.outputs[0];
    if (!output) throw new Error("Missing OAuth page bundle");
    await Bun.write(bundlePath, output);
    await import(pathToFileURL(bundlePath).href);
  } finally { await rm(bundlePath, { force: true }); dom.window.close(); }
}, 30_000);
