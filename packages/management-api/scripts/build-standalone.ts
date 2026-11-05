import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

function option(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing --${name}=...`);
  return value;
}

const packageRoot = resolve(import.meta.dir, "..");
const target = option("target");
const outfile = resolve(packageRoot, option("outfile"));
const outdir = await mkdtemp(join(tmpdir(), "supacloud-standalone-"));
const bundleName = "standalone.js";
const binaryName = basename(outfile);
try {
  const bundle = await Bun.build({
    entrypoints: [resolve(packageRoot, "src/standalone.ts")],
    target: "bun",
    outdir,
    naming: bundleName,
  });
  if (!bundle.success) {
    for (const log of bundle.logs) console.error(log);
    throw new Error("Management API standalone bundle failed");
  }

  const bundlePath = join(outdir, bundleName);
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
