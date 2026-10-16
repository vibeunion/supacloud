import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registry = "https://registry.npmjs.org";

/**
 * @param {unknown} manifest
 * @param {(args: string[]) => Promise<string>} runNpm
 */
export async function checkStarterDependencies(manifest, runNpm = async (args) =>
  (await execFileAsync("npm", args, { encoding: "utf8", timeout: 30_000 })).stdout) {
  assert.ok(manifest && typeof manifest === "object" && !Array.isArray(manifest), "Invalid starter manifest");
  const fields = /** @type {Record<string, unknown>} */ (manifest);
  /** @type {Record<string, string[]>} */
  const resolved = {};
  for (const field of ["dependencies", "devDependencies"]) {
    const dependencies = fields[field];
    assert.ok(dependencies && typeof dependencies === "object" && !Array.isArray(dependencies), `Missing ${field}`);
    for (const [name, range] of Object.entries(dependencies)) {
      if (!name.startsWith("@supacloud/")) continue;
      assert.ok(typeof range === "string" && /^[~^]?\d+\.\d+\.\d+$/.test(range),
        `Invalid registry dependency: ${name}`);
      const spec = `${name}@${range}`;
      try {
        /** @type {unknown} */
        const value = JSON.parse(await runNpm(["view", spec, "version", "--json", `--registry=${registry}`]));
        const versions = Array.isArray(value) ? /** @type {unknown[]} */ (value) : [value];
        assert.ok(versions.length > 0, `No published versions for ${spec}`);
        resolved[name] = versions.map(version => {
          assert.ok(typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
            `Invalid published version for ${spec}`);
          return version;
        });
      } catch (cause) {
        throw new Error(`Starter dependency is not confirmed in npm: ${spec}. Publish the compatible package set before the CLI; do not substitute workspace packages.`, { cause });
      }
    }
  }
  assert.ok(Object.keys(resolved).length > 0, "No framework dependencies in starter manifest");
  return resolved;
}

/** @param {string} bundlePath */
export async function checkCliStarterDependencies(bundlePath) {
  const root = await mkdtemp(join(tmpdir(), "supacloud-cli-release-"));
  try {
    const project = join(root, "application");
    await execFileAsync(bundlePath, ["app", "init", "--root", project,
      "--name", "release-reference", "--template", "command"], {
      cwd: root, timeout: 30_000,
      env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "SYSTEMROOT"].flatMap(key =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]])),
    });
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    const resolved = await checkStarterDependencies(manifest);
    console.log(`CLI command starter registry dependencies verified: ${JSON.stringify(resolved)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
