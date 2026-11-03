import { existsSync, readFileSync, readdirSync } from "node:fs";
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import scopedReylo from "./reylo-scoped-plugin";

function option(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

const packageRoot = resolve(import.meta.dir, "..");
const target = option("target");
const outfile = resolve(packageRoot, option("outfile"));
const cacheDir = join(packageRoot, ".reylo");
const manifestPath = join(cacheDir, "build-manifest.json");
const queryDir = join(cacheDir, "queries");
const hasCache = existsSync(manifestPath) && existsSync(queryDir)
  && readdirSync(queryDir).some((name) => name.endsWith(".json"));

if (!hasCache && !process.env.DATABASE_URL) {
  throw new Error("Reylo cache is missing. Run `bun run reylo:contracts` with DATABASE_URL, or set DATABASE_URL for this build");
}
if (hasCache) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { commit?: string | null };
  const head = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"], cwd: packageRoot, stdout: "pipe", stderr: "ignore" });
  if (head.exitCode === 0 && manifest.commit && manifest.commit !== head.stdout.toString().trim() && !process.env.DATABASE_URL) {
    throw new Error(`Reylo cache belongs to ${manifest.commit}, not ${head.stdout.toString().trim()}; regenerate it for this commit`);
  }
}

const outdir = await mkdtemp(join(tmpdir(), "supacloud-standalone-"));
const bundleName = "standalone.js";
const binaryName = basename(outfile);
try {
  const bundle = await Bun.build({
    entrypoints: [resolve(packageRoot, "src/standalone.ts")],
    target: "bun",
    outdir,
    naming: bundleName,
    plugins: [scopedReylo()],
    define: { __SUPACLOUD_REYLO_QUERIES__: JSON.stringify(true) },
  });
  if (!bundle.success) {
    for (const log of bundle.logs) console.error(log);
    throw new Error("Management API standalone bundle failed");
  }

  const bundlePath = join(outdir, bundleName);
  const source = await Bun.file(bundlePath).text();
  for (const query of ["from project_tasks", "from project_task_attempts"]) {
    if (!source.includes(query)) throw new Error(`Bundled control-plane query is missing: ${query}`);
  }
  if (/from\s+["'][^"']+\.sql["']/.test(source)) throw new Error("Bundled output still contains a .sql import");
  if (source.includes("@reylosql/engine")) throw new Error("Bundled output unexpectedly contains the Reylo native engine");

  const compile = Bun.spawnSync({
    cmd: [process.execPath, "build", bundlePath, "--compile", "--target", target, "--outfile", outfile],
    stdout: "inherit",
    stderr: "inherit",
  });
  if (compile.exitCode !== 0) throw new Error(`bun build --compile failed for ${target}`);

  await chmod(outfile, 0o755);
  const hostTarget = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  if (target === hostTarget) {
    const isolated = await mkdtemp(join(tmpdir(), "supacloud-standalone-run-"));
    const isolatedBinary = join(isolated, binaryName);
    await cp(outfile, isolatedBinary);
    try {
      const run = Bun.spawnSync({ cmd: [isolatedBinary, "--version"], cwd: isolated, stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0 || !run.stdout.toString().includes("SupaCloud Version:")) {
        throw new Error(`Compiled binary failed isolated startup: ${run.stderr.toString() || run.stdout.toString()}`);
      }
    } finally {
      await rm(isolated, { recursive: true, force: true });
    }
  }
  console.log(`built ${outfile} (${target})`);
} finally {
  await rm(outdir, { recursive: true, force: true });
}
