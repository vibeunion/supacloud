import { createHash } from "crypto";
import { existsSync, readFileSync, rmSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const generatedPath = resolve(root, "generated/embedded-worker.ts");
const tmpDir = resolve(root, ".tmp/compiled-worker");
const workerBundlePath = resolve(tmpDir, "worker-executor.js");

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = Bun.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
}

const target = argValue("--target");
const outfile = argValue("--outfile");

if (!target || !outfile) {
  console.error("Usage: bun run scripts/build-compiled.ts --target <bun-target> --outfile <path>");
  process.exit(1);
}

const originalGenerated = existsSync(generatedPath)
  ? readFileSync(generatedPath, "utf8")
  : 'export const EMBEDDED_WORKER_HASH = "";\nexport const EMBEDDED_WORKER_SOURCE = "";\n';

try {
  rmSync(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  const result = await Bun.build({
    entrypoints: [resolve(root, "worker-executor.ts")],
    outdir: tmpDir,
    target: "bun",
    format: "esm",
    minify: false,
    sourcemap: "none",
    naming: {
      entry: "worker-executor.js",
    },
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }

  const workerSource = readFileSync(workerBundlePath, "utf8");
  const workerHash = createHash("sha256").update(workerSource).digest("hex").slice(0, 16);
  await mkdir(dirname(generatedPath), { recursive: true });
  await writeFile(
    generatedPath,
    [
      `export const EMBEDDED_WORKER_HASH = ${JSON.stringify(workerHash)};`,
      `export const EMBEDDED_WORKER_SOURCE = ${JSON.stringify(workerSource)};`,
      "",
    ].join("\n"),
  );

  await $`bun build cli.ts --compile --target=${target} --outfile=${outfile}`.cwd(root);
} finally {
  await writeFile(generatedPath, originalGenerated);
  rmSync(tmpDir, { recursive: true, force: true });
}
