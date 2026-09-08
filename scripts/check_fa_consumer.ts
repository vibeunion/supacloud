import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const source = resolve(process.argv[2] ?? join(repo, "../xigu-fa"));
const root = await mkdtemp(join(tmpdir(), "supacloud-fa-consumer-"));
const project = join(root, "fa");
// Do not inherit database/auth/deployment credentials or load the consumer's .env.
const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].flatMap((key) =>
  process.env[key] ? [[key, process.env[key]!]] : []));
const evidence: Record<string, unknown> = { source, database: "not-run", liveAuth: "not-run", deployed: false };
async function run(args: string[], cwd = project): Promise<string> {
  const child = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill(), 300_000);
  try {
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    assert.equal(status, 0, `${args.join(" ")}\n${stdout}\n${stderr}`);
    return stdout + stderr;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
}
const bun = (...args: string[]) => [process.execPath, "--no-env-file", ...args];
try {
  await mkdir(project);
  const inventory = (await run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], source)).split("\0");
  const fingerprint = createHash("sha256");
  let count = 0;
  for (const path of [...new Set(inventory)].sort()) {
    // Source-only snapshot, including uncommitted edits. No symlinks, secrets,
    // private documents, caches, credentials or deployment output.
    if (!path || path.split("/").some((part) => part.startsWith(".") || ["node_modules", "dist", "build", "output"].includes(part))) continue;
    if (!/\.(ts|tsx|js|mjs|cjs|json|svelte|css|html|sql)$/.test(path) && !["bun.lock", "bunfig.toml"].includes(path)) continue;
    if (/credential|secret|service.account|token.*\.json$|key.*\.json$/i.test(path)) continue;
    const absolute = join(source, path);
    const stat = await lstat(absolute).catch(() => null);
    if (!stat?.isFile()) continue;
    const bytes = await readFile(absolute);
    fingerprint.update(path + "\0").update(bytes);
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), bytes);
    count++;
  }
  evidence.snapshot = { files: count, sha256: fingerprint.digest("hex") };
  const manifestPath = join(project, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const packages: Record<string, string> = {};
  for (const name of ["app", "compiler", "elysia"]) {
    const directory = join(repo, "packages", name);
    await run(bun("run", "build"), directory);
    await run(bun("pm", "pack", "--destination", root), directory);
    const tarball = (await readdir(root)).find((file) => file.startsWith(`supacloud-${name}-`) && file.endsWith(".tgz"));
    assert.ok(tarball);
    const artifact = join(root, tarball);
    packages[name] = createHash("sha256").update(await readFile(artifact)).digest("hex");
    const deps = name === "compiler" ? manifest.devDependencies : manifest.dependencies;
    deps[`@supacloud/${name}`] = `file:${artifact}`;
  }
  evidence.packages = packages;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await run(bun("install", "--ignore-scripts"));
  // Source migration, never generated-code rewriting. A stale migration fails closed.
  await run(["git", "apply", "--recount", "--unidiff-zero", join(repo, "scripts/fixtures/fa-candidate.patch")]);
  await copyFile(join(repo, "scripts/fixtures/fa-candidate-test.fixture"), join(project, "tests/supacloud-candidate.test.ts"));
  assert.ok(!(await readFile(join(project, "scripts/fa-app-framework-compile.ts"), "utf8")).includes("postProcessGeneratedArtifacts"));
  console.log("FA consumer: installed candidate packages and migrated DELETE to the POST command protocol");
  console.log(await run(bun("scripts/fa-app-framework-compile.ts", "--force")));
  console.log(await run(bun("scripts/fa-app-framework-compile.ts", "--check", "--force")));
  // These tests use local fakes. No SSH, remote database, production login or deployment.
  const testOutput = await run(bun("test",
    "supacloud/fa/app/features/config/config.test.ts",
    "tests/fa-app-framework-compile.test.ts",
    "tests/fa-command-contract.test.ts",
    "tests/fa-high-risk-command-contracts.test.ts",
    "tests/supacloud-candidate.test.ts"));
  console.log(testOutput.split("\n").slice(-6).join("\n"));
  console.log(await run(bun("build", "node_modules/@supacloud/app/dist/contract_client.js",
    "--target", "browser", "--outfile", join(root, "browser-contract.js"))));
  evidence.compatibility = "passed";
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
