import { expect, test } from "bun:test";
import { resolve } from "node:path";

// Keep runtime regression suites in their owning packages: importing their
// implementations here would apply the repository tools' compiler options to
// the entire runtime graph instead of each package's TypeScript policy.
for (const [name, directory, suite] of [
  ["document", "packages/worker", "tests/conversion-size-limits.test.ts"],
  ["image", "packages/supacloud-lite", "test/conversion-size-limits.test.ts"],
] as const) {
  test(`${name} conversion size limits remain covered by the package suite`, async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", "test", suite], {
      cwd: resolve(import.meta.dir, "..", directory),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
  }, 30_000);
}
