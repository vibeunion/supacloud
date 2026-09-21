import { expect, spyOn, test } from "bun:test";
import type { BunPlugin } from "bun";
import { JSDOM } from "jsdom";
import { compile, preprocess } from "svelte/compiler";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  formatSystemInfo, type SystemInfoSnapshot,
} from "../../../management-api/src/services/system-info";
import {
  parseDashboardProjects, parseDashboardSystemInfo, loadDashboardProjects, loadDashboardSystemInfo,
} from "../lib/dashboard";
import { projectListFixture } from "../lib/project-list.test-fixtures";

function snapshot(): SystemInfoSnapshot {
  return {
    cpus: [{ user: 10, nice: 5, sys: 5, idle: 75, irq: 5 }],
    totalMemory: 2048 * 1024 * 1024, freeMemory: 1024 * 1024 * 1024,
    uptime: 93780, processUptime: 30.9, version: "1.2.3-beta+sha",
    platform: "linux", arch: "arm64", hostname: "test",
  };
}
const system = () => formatSystemInfo(snapshot());

test("native system formatter and Console decoder agree on cumulative CPU, duration and version", () => {
  expect(parseDashboardSystemInfo(system())).toEqual({
    cpu: "25.0%", memory: "1024 / 2048 MB", uptime: "1d 2h 3m", version: "1.2.3-beta+sha",
  });
  expect(system().processUptime).toBe(30);
  for (const uptime of [0, 59, 60, 3599, 3600, 86399, 86400, 90000, 10 ** 9, Number.MAX_SAFE_INTEGER]) {
    const formatted = formatSystemInfo({ ...snapshot(), uptime });
    expect(parseDashboardSystemInfo(formatted).uptime).toBe(formatted.uptime);
  }
  for (const idle of [0, 100]) {
    expect(parseDashboardSystemInfo(formatSystemInfo({
      ...snapshot(), cpus: [{ user: 100 - idle, nice: 0, sys: 0, idle, irq: 0 }],
    })).cpu).toBe(idle === 0 ? "100.0%" : "0.0%");
  }
});

test("invalid system collection and malformed wire metrics fail instead of producing placeholders", () => {
  for (const patch of [
    { cpus: [] }, { cpus: [{ user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }] },
    { cpus: [{ user: NaN, nice: 0, sys: 0, idle: 1, irq: 0 }] },
    { cpus: [{ user: -1, nice: 0, sys: 0, idle: 1, irq: 0 }] },
    { cpus: [{ user: Number.MAX_SAFE_INTEGER, nice: 1, sys: 0, idle: 1, irq: 0 }] },
    { totalMemory: 0 }, { freeMemory: Number.MAX_SAFE_INTEGER }, { freeMemory: -1 },
    { uptime: Infinity }, { processUptime: -1 }, { version: "" }, { hostname: "\0" },
  ]) expect(() => formatSystemInfo({ ...snapshot(), ...patch })).toThrow();
  for (const value of [null, [], {}, { ...system(), cpu: "NaN%" }, { ...system(), cpu: "100.1%" },
    { ...system(), cpu: "-1.0%" }, { ...system(), memory: "4 / 3 MB" },
    { ...system(), memory: "9007199254740992 / 9007199254740992 MB" },
    ...["24h 0m", "1d 24h 0m", "1d 0m", "00m", "60m", "0h 1m",
      "999999999999999999d 0h 0m"].map(uptime => ({ ...system(), uptime })),
    { ...system(), version: "-" },
  ]) expect(() => parseDashboardSystemInfo(value)).toThrow();
});

test("dashboard projects reject malformed and duplicate rows and sort canonical timestamps", () => {
  const a = projectListFixture(["a"])[0];
  const b = projectListFixture(["b"])[0];
  if (!a || !b) throw new Error("Missing project fixture");
  expect(parseDashboardProjects([a, { ...b, created_at: "2026-09-02T00:00:00.000Z" }]).map(row => row.ref)).toEqual(["b", "a"]);
  expect(parseDashboardProjects([])).toEqual([]);
  for (const value of [{}, [a, a], [{ ...a, id: "" }], [{ ...a, status: "healthy" }],
    ...[undefined, "bad", "2026-02-30T00:00:00.000Z", "2026-09-01"].map(created_at => [{ ...a, created_at }]),
  ]) expect(() => parseDashboardProjects(value)).toThrow();
});

test("dashboard transports enforce bounds, cancellation and no-store without empty fallbacks", async () => {
  for (const [loader, path, body, maxBytes] of [
    [loadDashboardProjects, "/v1/projects", projectListFixture(), 1024 * 1024],
    [loadDashboardSystemInfo, "/v1/system/info", system(), 64 * 1024],
  ] as const) {
    let calls = 0;
    const request = async (url: string, options: RequestInit) => {
      calls++;
      expect(url).toBe(path);
      expect(options.cache).toBe("no-store");
      expect(options.redirect).toBe("error");
      return Response.json(body);
    };
    await loader(request, new AbortController().signal);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(loader(request, cancelled.signal)).rejects.toThrow();
    expect(calls).toBe(1);
    await expect(loader(async () => Response.json({}, { status: 503 }), new AbortController().signal)).rejects.toThrow();
    await expect(loader(async () => new Response("x".repeat(maxBytes + 1)), new AbortController().signal)).rejects.toThrow();
    await expect(loader(async () => Response.json({}), new AbortController().signal)).rejects.toThrow();
  }
});

test("actual system info route requires administrator authorization and returns sanitized 503 on collection failure", async () => {
  const { systemRoutes } = await import("../../../management-api/src/routes/system");
  const module = await import("../../../management-api/src/services/system-info");
  const authModule = await import("../../../management-api/src/middleware/auth");
  const { config } = await import("../../../management-api/src/config");
  const originalToken = config.masterToken;
  config.masterToken = "dashboard-test-master-token";
  const collect = spyOn(module, "collectSystemInfo").mockResolvedValue(system());
  const request = (authorized = true) => systemRoutes.handle(new Request("http://localhost/v1/system/info", {
    headers: authorized ? { Authorization: "Bearer dashboard-test-master-token" } : {},
  }));
  try {
    const denied = await request(false);
    expect(denied.status, await denied.text()).toBe(401);
    expect(collect).not.toHaveBeenCalled();
    const response = await request();
    expect(response.status).toBe(200);
    expect(parseDashboardSystemInfo(await response.json())).toEqual(parseDashboardSystemInfo(system()));
    collect.mockRejectedValue(new Error("private system failure"));
    const unavailable = await request();
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      code: "SYSTEM_INFO_UNAVAILABLE", message: "System information unavailable",
    });
    const auth = spyOn(authModule, "getAuthContext").mockResolvedValue({ role: "project", ref: "a", principalId: "project:a" });
    try {
      collect.mockClear();
      expect((await request()).status).toBe(403);
      expect(collect).not.toHaveBeenCalled();
    } finally { auth.mockRestore(); }
  } finally {
    config.masterToken = originalToken;
    collect.mockRestore();
  }
});

const localFile = (path: string) => fileURLToPath(new URL(path, import.meta.url));
function compiler(): BunPlugin {
  return {
    name: "dashboard-tests",
    setup(builder) {
      builder.onResolve({ filter: /^(\$app\/(paths|navigation)|svelte-i18n)$/ },
        () => ({ path: localFile("dashboard.test-fixture.ts") }));
      builder.onResolve({ filter: /^\$lib\/(api|dashboard)$/ },
        ({ path }) => ({ path: localFile(`../lib/${path.slice("$lib/".length)}.ts`) }));
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await preprocess(await Bun.file(path).text(), vitePreprocess(), { filename: path });
        return { contents: compile(source.code, { filename: path, generate: "client", css: "injected" }).js.code, loader: "js" };
      });
    },
  };
}

test("compiled dashboard separates resources, clears failures and fences refresh/unmount races", async () => {
  if (process.env.SUPACLOUD_DASHBOARD_TEST !== "1") {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", fileURLToPath(import.meta.url)],
      env: { ...process.env, SUPACLOUD_DASHBOARD_TEST: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
  const window = dom.window;
  Object.assign(globalThis, {
    window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element, Node: window.Node, Text: window.Text, Comment: window.Comment,
    Event: window.Event, CustomEvent: window.CustomEvent, MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window), MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  });
  const bundlePath = join(tmpdir(), `supacloud-dashboard-${crypto.randomUUID()}.mjs`);
  try {
    const result = await Bun.build({
      entrypoints: [localFile("dashboard.test-entry.ts")], target: "browser", format: "esm",
      conditions: ["svelte", "browser"], external: ["node:assert"], plugins: [compiler()],
    });
    if (!result.success) throw new AggregateError(result.logs, "Dashboard fixture build failed");
    const output = result.outputs[0];
    if (!output) throw new Error("Missing dashboard fixture bundle");
    await Bun.write(bundlePath, output);
    await import(pathToFileURL(bundlePath).href);
  } finally {
    await rm(bundlePath, { force: true });
    dom.window.close();
  }
}, 30_000);
