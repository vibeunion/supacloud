import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Resolve from the app, not the CLI, so capture and bundling share Elysia's ESM instance.
const runner = `
import { pathToFileURL } from "node:url";
import { basename, dirname } from "node:path";
const [entry, appEntry, outfile, minify] = Bun.argv.slice(1);
const plugin = await import(import.meta.resolve("elysia/plugin/aot/bun", pathToFileURL(appEntry).href));
const result = await Bun.build({
  entrypoints: [entry], outdir: dirname(outfile), naming: { entry: basename(outfile) },
  target: "bun", format: "esm", splitting: false, metafile: true,
  minify: minify === "true", env: "disable",
  plugins: [plugin.aot(appEntry, {
    strip: false, production: false,
    registerFrom: Bun.fileURLToPath(import.meta.resolve("elysia", pathToFileURL(appEntry).href)),
    reconstructFrom: Bun.fileURLToPath(import.meta.resolve("elysia/reconstruct", pathToFileURL(appEntry).href))
  }), {
    name: "resolve-aot-manifest-dependencies",
    setup(build) {
      build.onResolve({ filter: /^(elysia|typebox)(\\/.*)?$/ }, ({ path }) => ({
        path: Bun.fileURLToPath(import.meta.resolve(path, pathToFileURL(appEntry).href))
      }));
    }
  }]
});
if (!result.success) throw new Error(result.logs.map(log => log.message).join("\\n"));
if (!Object.keys(result.metafile.inputs).some(input => input.includes("elysia-aot") && input.endsWith("manifest"))) {
  throw new Error("AOT app entry is not in the bundle graph; compiled manifest was not injected");
}
if (result.outputs.length !== 1) throw new Error("AOT requires a single JavaScript bundle without sidecar assets");
await Bun.write(outfile, await result.outputs[0].text());
process.exit(0);
`;

export function validateFunctionAot(args: Record<string, unknown>): void {
    if (args.aot !== undefined && args.action !== "deploy") {
        throw new Error("'--aot' is only supported for 'deploy'");
    }
    if (args["aot-entry"] !== undefined && args.aot !== true) {
        throw new Error("'--aot-entry' requires '--aot'");
    }
    if (args.aot !== true) return;
    if (args.framework !== "elysia") throw new Error("'--aot' requires 'framework=elysia'");
    if (typeof args.path !== "string" || args.code !== undefined || args["prebundled-path"] !== undefined) {
        throw new Error("'--aot' requires '--path' without '--code' or '--prebundled-path'");
    }
}

export async function buildFunctionAot(
    entrypoint: string,
    outfile: string,
    options: { appEntry?: string; minify?: boolean } = {},
): Promise<{ code: string; prebundled: true; expectedSha256: string }> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    env.NODE_ENV = "production";
    try {
        const { stderr } = await execFileAsync("bun", [
            "--no-env-file", "--eval", runner,
            resolve(entrypoint), resolve(options.appEntry ?? entrypoint), outfile, String(options.minify === true),
        ], {
            cwd: dirname(entrypoint), env, timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
        });
        if (stderr) process.stderr.write(stderr);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Local Elysia AOT build failed (Bun and the app's Elysia AOT plugin are required): ${message}`);
    }
    const code = readFileSync(outfile, "utf8");
    if (!code.trim()) throw new Error("AOT build produced an empty bundle");
    return { code, prebundled: true, expectedSha256: createHash("sha256").update(code).digest("hex") };
}
