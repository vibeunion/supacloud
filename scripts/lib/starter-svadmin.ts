import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BunPlugin } from "bun";

export async function checkStarterSvadmin(root: string): Promise<void> {
  const repo = resolve(import.meta.dir, "../.."), web = join(repo, "packages/web-console");
  const config = join(root, "tsconfig.svadmin.json");
  await writeFile(config, JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true,
      noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, noPropertyAccessFromIndexSignature: true,
      skipLibCheck: true, noEmit: true, types: [], allowJs: true,
      paths: {
        "@supacloud/js/contracts": [join(repo, "packages/contracts/src/authenticated_fetch.ts")],
        "@supabase/supabase-js": [join(repo, "packages/cli/node_modules/@supabase/supabase-js")],
        "svelte": [join(web, "node_modules/svelte")],
        "svelte/*": [join(web, "node_modules/svelte/*")],
        "@svadmin/ui/*": [join(web, "node_modules/@svadmin/ui/dist/*")],
      },
    },
    include: ["tests/starter-svadmin.svelte", "tests/starter-svadmin-client.ts", "tests/starter-browser-session.ts", "src/client/*.ts"],
  }));
  const child = Bun.spawn([process.execPath, join(web, "node_modules/svelte-check/bin/svelte-check"),
    "--workspace", root, "--tsconfig", config, "--fail-on-warnings"], {
    cwd: root, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error("SVAdmin fixture typecheck failed:\n" + stdout + stderr);
  } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
}

/** Optional acceptance adapter; no Svelte dependency enters the generated starter. */
export async function starterSvadminBundle() {
  const web = resolve(import.meta.dir, "../../packages/web-console");
  // Resolve the public export only when this optional fixture is requested.
  // Tooling-only checks do not install the Web Console's UI dependency graph.
  const { compile, compileModule }: {
    compile(source: string, options: { filename: string; generate: "client"; css: "external" }): {
      js: { code: string }; css: { code: string } | null;
    };
    compileModule(source: string, options: { filename: string; generate: "client" }): { js: { code: string } };
  } = await import(Bun.resolveSync("svelte/compiler", web));
  const styles: string[] = [];
  const plugin: BunPlugin = {
    name: "starter-svadmin-acceptance",
    setup(build) {
      build.onResolve({ filter: /^(svelte(?:\/|$)|@svadmin\/ui(?:\/|$))/ }, args => ({
        path: args.path === "svelte"
          ? join(web, "node_modules/svelte/src/index-client.js") : Bun.resolveSync(args.path, web),
      }));
      build.onLoad({ filter: /\.svelte$/ }, async args => {
        const compiled = compile(await readFile(args.path, "utf8"), { filename: args.path, generate: "client", css: "external" });
        if (compiled.css) styles.push(compiled.css.code);
        return { contents: compiled.js.code, loader: "js" };
      });
      build.onLoad({ filter: /\.svelte\.[jt]s$/ }, async args => {
        const source = await readFile(args.path, "utf8");
        const javascript = args.path.endsWith(".ts") ? new Bun.Transpiler({ loader: "ts" }).transformSync(source) : source;
        return { contents: compileModule(javascript, { filename: args.path, generate: "client" }).js.code, loader: "js" };
      });
    },
  };
  return {
    plugin,
    async css() { return await readFile(Bun.resolveSync("@svadmin/ui/app.css", web), "utf8") + "\n" + styles.join("\n"); },
  };
}
