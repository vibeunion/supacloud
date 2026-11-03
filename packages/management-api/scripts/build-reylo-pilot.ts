import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import reylo from "reylo/esbuild";

const packageRoot = resolve(import.meta.dir, "..");
const entrypoint = resolve(packageRoot, "src/db/reylo-pilot/compiled-entry.ts");
const outdir = await mkdtemp(join(tmpdir(), "reylo-pilot-build-"));
const bundleName = "reylo-pilot.bundle.js";
const binaryName = "reylo-pilot";

try {
  const bundle = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    outdir,
    naming: bundleName,
    plugins: [reylo()],
  });
  if (!bundle.success) {
    for (const log of bundle.logs) console.error(log);
    throw new Error("Reylo pilot bundle failed");
  }

  const bundlePath = join(outdir, bundleName);
  const source = await Bun.file(bundlePath).text();
  for (const query of ["from project_tasks", "from project_task_attempts", "from projects", "from organizations"]) {
    if (!source.includes(query)) throw new Error(`Bundled query is missing: ${query}`);
  }
  if (/from\s+["'][^"']+\.sql["']/.test(source)) {
    throw new Error("Bundled output still contains a .sql import");
  }
  if (source.includes("@reylosql/engine")) {
    throw new Error("Bundled output unexpectedly contains the Reylo native engine");
  }

  const compile = Bun.spawnSync({
    cmd: [process.execPath, "build", bundlePath, "--compile", "--outfile", join(outdir, binaryName)],
    stdout: "inherit",
    stderr: "inherit",
  });
  if (compile.exitCode !== 0) throw new Error("bun build --compile failed");

  const binary = join(outdir, binaryName);
  await chmod(binary, 0o755);
  const isolated = await mkdtemp(join(tmpdir(), "reylo-pilot-run-"));
  const isolatedBinary = join(isolated, binaryName);
  await cp(binary, isolatedBinary);
  const run = Bun.spawnSync({ cmd: [isolatedBinary], cwd: isolated, env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "" } });

  // Without a database the compiled binary still starts far enough to reject the
  // missing DATABASE_URL, which proves the query module and Reylo decoder were
  // embedded rather than loaded from node_modules or .sql files.
  const stderr = run.stderr.toString();
  const stdout = run.stdout.toString();
  if (process.env.DATABASE_URL) {
    if (run.exitCode !== 0) throw new Error(`Compiled pilot failed: ${stderr || stdout}`);
    const report = JSON.parse(stdout.trim()) as { queries?: number };
    if (report.queries !== 7) throw new Error("Compiled pilot did not execute all seven queries");
    console.log(`compiled binary executed 7 queries in isolation: ${isolatedBinary}`);
  } else if (!stderr.includes("DATABASE_URL is required")) {
    throw new Error(`Compiled pilot did not start as expected: ${stderr || stdout}`);
  } else {
    console.log(`compiled binary starts in isolation: ${isolatedBinary}`);
  }
  console.log(`bundle: ${bundlePath}`);
  await rm(isolated, { recursive: true, force: true });
} finally {
  await rm(outdir, { recursive: true, force: true });
}
