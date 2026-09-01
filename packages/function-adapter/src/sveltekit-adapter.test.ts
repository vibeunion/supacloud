import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import adapter from "./sveltekit-adapter";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })));
});

describe("SvelteKit Function adapter", () => {
  test("builds a real API-only SvelteKit project as a Fetch Function", async () => {
    const project = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-function-"));
    fixtures.push(project);
    await mkdir(join(project, "src/routes"), { recursive: true });
    await symlink(join(import.meta.dir, "../node_modules"), join(project, "node_modules"));
    const adapterUrl = pathToFileURL(join(import.meta.dir, "sveltekit-adapter.ts")).href;
    await Promise.all([
      writeFile(join(project, "package.json"), JSON.stringify({ private: true, type: "module" })),
      writeFile(join(project, "svelte.config.js"), `import adapter from ${JSON.stringify(adapterUrl)};\nexport default { kit: { adapter: adapter() } };\n`),
      writeFile(join(project, "vite.config.js"), 'import { sveltekit } from "@sveltejs/kit/vite";\nexport default { plugins: [sveltekit()] };\n'),
      writeFile(join(project, "src/app.html"), '<!doctype html><html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>\n'),
      writeFile(join(project, "src/routes/+server.js"), 'export function GET() { return Response.json({ ok: true }); }\n'),
      writeFile(join(project, "src/hooks.server.js"), 'export async function handle({ event, resolve }) { const response = await resolve(event); response.headers.set("x-hook", "active"); return response; }\n'),
    ]);

    const build = Bun.spawn(["bun", "x", "vite", "build"], {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    const entry = await readFile(join(project, "build/index.js"), "utf8");
    expect(entry).toContain('framework: "sveltekit-function"');
    expect(entry).toContain("server.respond(request");
    const mod = await import(pathToFileURL(join(project, "build/index.js")).href) as {
      default: { fetch(request: Request): Promise<Response> };
    };
    const response = await mod.default.fetch(new Request("https://edge/"));
    expect(response.headers.get("x-hook")).toBe("active");
    expect(await response.json()).toEqual({ ok: true });
  }, 30_000);

  test("declares server reads and instrumentation unsupported", () => {
    const supports = adapter().supports;
    expect(supports?.read?.({ config: {}, route: { id: "/api" } })).toBe(false);
    expect(supports?.instrumentation?.()).toBe(false);
  });

  test("rejects page routes before writing output", () => {
    expect(() => adapter().adapt({
      routes: [{ id: "/page", page: { methods: ["GET"] } }],
    } as never)).toThrow("supports API routes only");
  });

  test("rejects prerendered output before writing output", () => {
    expect(() => adapter().adapt({
      routes: [],
      prerendered: { paths: ["/api"] },
    } as never)).toThrow("does not serve prerendered or static output");
  });

  test("rejects static assets before writing output", async () => {
    const project = await mkdtemp(join(tmpdir(), "supacloud-sveltekit-static-"));
    fixtures.push(project);
    const assets = join(project, "static");
    await mkdir(assets);
    await writeFile(join(assets, "robots.txt"), "User-agent: *\n");

    expect(() => adapter().adapt({
      routes: [],
      prerendered: { paths: [] },
      config: { kit: { files: { assets } } },
    } as never)).toThrow("does not serve static assets");
  });

  test("rejects server asset reads before writing output", () => {
    expect(() => adapter().adapt({
      routes: [],
      prerendered: { paths: [] },
      config: { kit: { files: { assets: join(tmpdir(), "supacloud-missing-assets") } } },
      findServerAssets: () => ["private/model.bin"],
    } as never)).toThrow("does not support server asset reads");
  });
});
