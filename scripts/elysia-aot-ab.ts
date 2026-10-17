import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dir, "..");

// Each candidate gets a fresh process. App capture must not see operator credentials or config files.
export function platformBuildEnvironment(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {
    ...env,
    NODE_ENV: "test",
    SUPACLOUD_MANAGEMENT_ENV_FILE: join(scratch, "absent-management.env"),
    SUPACLOUD_LOCAL_ENV_FILE: join(scratch, "absent-local.env"),
    SUPACLOUD_LEGACY_CONFIG_ENV_FILE: join(scratch, "absent-legacy.env"),
    DATABASE_URL: "postgres://aot:aot@127.0.0.1:1/aot",
    PGHOST: "127.0.0.1",
    PGPORT: "1",
    MANAGEMENT_API_URL: "http://127.0.0.1:1",
    EDGE_FUNCTIONS_DIR: join(scratch, "functions"),
    EDGE_FUNCTIONS_BASE_DIR: join(scratch, "functions"),
  };
}

export async function buildCandidate(
  component: "management-api" | "edge-runtime",
  mode: "plain" | "aot",
  outdir: string,
  entries?: { appEntry: string; entry: string },
): Promise<void> {
  const packageRoot = join(root, "packages", component);
  const appEntry = entries?.appEntry ?? join(packageRoot, component === "management-api" ? "src/index.ts" : "server.ts");
  const entry = entries?.entry ?? join(packageRoot, component === "management-api" ? "src/standalone.ts" : "cli.ts");
  const plugins: Bun.BunPlugin[] = [];
  if (mode === "aot") {
    const moduleUrl = import.meta.resolve("elysia/plugin/aot/bun", pathToFileURL(appEntry).href);
    const { aot } = await import(moduleUrl) as {
      aot(entry: string, options: {
        strip: false; production: false; registerFrom: string; reconstructFrom: string;
      }): Bun.BunPlugin;
    };
    plugins.push(aot(appEntry, {
      strip: false, production: false,
      registerFrom: Bun.fileURLToPath(import.meta.resolve("elysia", pathToFileURL(appEntry).href)),
      reconstructFrom: Bun.fileURLToPath(import.meta.resolve("elysia/reconstruct", pathToFileURL(appEntry).href)),
    }));
    plugins.push({
      name: "resolve-aot-manifest-dependencies",
      setup(build) {
        build.onResolve({ filter: /^(elysia|typebox)(\/.*)?$/ }, ({ path }) => ({
          path: Bun.fileURLToPath(import.meta.resolve(path, pathToFileURL(appEntry).href)),
        }));
      },
    });
  }
  if (component === "edge-runtime") {
    const worker = await Bun.build({
      entrypoints: [join(packageRoot, "worker-executor.ts")], target: "bun", format: "esm", env: "disable",
    });
    if (!worker.success || worker.outputs.length !== 1) throw new Error("Worker bundle failed");
    const source = await worker.outputs[0]!.text();
    const hash = new Bun.CryptoHasher("sha256").update(source).digest("hex").slice(0, 16);
    plugins.push({
      name: "embed-unchanged-worker",
      setup(build) {
        build.onLoad({ filter: /[\\/]generated[\\/]embedded-worker\.ts$/ }, () => ({
          loader: "ts",
          contents: `export const EMBEDDED_WORKER_HASH = ${JSON.stringify(hash)};\nexport const EMBEDDED_WORKER_SOURCE = ${JSON.stringify(source)};`,
        }));
      },
    });
  }
  const result = await Bun.build({
    entrypoints: [entry], outdir, naming: { entry: `${component}-${mode}.js` },
    target: "bun", format: "esm", env: "disable", minify: false, splitting: false, metafile: true, plugins,
  });
  if (!result.success) throw new Error(result.logs.map(log => log.message).join("\n"));
  if (mode === "aot" && !Object.keys(result.metafile?.inputs ?? {}).some(input =>
    input.includes("elysia-aot") && input.endsWith("manifest"))) {
    throw new Error("AOT compiled manifest was not injected");
  }
  for (const artifact of result.outputs) {
    const source = await artifact.text();
    if (!source.trim()) throw new Error("Platform build produced an empty artifact");
    await Bun.write(artifact.path, source);
  }
  return;
}

if (import.meta.main) {
  const [component, output = "./dist/aot-ab", mode] = Bun.argv.slice(2);
  if (component !== "management-api" && component !== "edge-runtime") {
    throw new Error("Usage: bun scripts/elysia-aot-ab.ts <management-api|edge-runtime> [outdir]");
  }
  if (mode === "plain" || mode === "aot") {
    try {
      await buildCandidate(component, mode, resolve(output));
      process.exit(0);
    } catch (error) {
      console.error(error);
      if (error instanceof AggregateError) {
        for (const detail of error.errors) console.error(detail);
      }
      process.exit(1);
    }
  } else {
    const outdir = resolve(output);
    await mkdir(outdir, { recursive: true });
    const scratch = await mkdtemp(join(tmpdir(), "supacloud-platform-aot-"));
    try {
      for (const candidate of ["plain", "aot"]) {
        const { stdout, stderr } = await execFileAsync(process.execPath, [
          "--no-env-file", import.meta.path, component, outdir, candidate,
        ], {
          env: platformBuildEnvironment(scratch),
          cwd: scratch, timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
        });
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        console.log(`${candidate}: ${join(outdir, `${component}-${candidate}.js`)}`);
      }
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
