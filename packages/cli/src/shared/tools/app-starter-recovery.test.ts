import { expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Load the repository-only fixture at runtime so CLI declaration output stays
// inside src; the helper is checked separately by tsconfig.tools.json.
const { prepareStarterSourceFixture }: {
  prepareStarterSourceFixture(root: string): Promise<void>;
} = await import(new URL("../../../../../scripts/lib/starter-source-fixture.ts", import.meta.url).href);

const postgresBin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];

test.skipIf(!postgresBin)("generated receipt routes recover durable operations without writes or authorization bypass", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-recovery-"));
  const repo = resolve(import.meta.dir, "../../../../..");
  try {
    await prepareStarterSourceFixture(root);
    await copyFile(join(repo, "scripts/fixtures/starter-recovery.fixture"), join(root, "tests/recovery.test.ts"));
    const child = Bun.spawn([process.execPath, "test", "--no-env-file", "--tsconfig-override", join(root, "tsconfig.json"), "tests/recovery.test.ts"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", SUPACLOUD_STARTER_POSTGRES_BIN: postgresBin! },
      stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 90_000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect({ code, failure: code ? stdout + stderr : "" }).toEqual({ code: 0, failure: "" });
    } finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 100_000);
