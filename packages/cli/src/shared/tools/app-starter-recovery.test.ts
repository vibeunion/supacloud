import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { appStarterFiles } from "./app-starter";

const postgresBin = process.env["SUPACLOUD_STARTER_POSTGRES_BIN"];

test.skipIf(!postgresBin)("generated receipt routes recover durable operations without writes or authorization bypass", async () => {
  const root = await mkdtemp(join(tmpdir(), "starter-recovery-"));
  const repo = resolve(import.meta.dir, "../../../../..");
  try {
    const files = appStarterFiles("recovery-test");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    await symlink(join(repo, "packages/elysia/node_modules"), join(root, "node_modules"), "dir");
    const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
    config.compilerOptions.paths = Object.fromEntries(
      ["app", "elysia", "commands", "contracts", "db", "query"].map(name =>
        [`@supacloud/${name}`, [join(repo, "packages", name, "src/index.ts")]]),
    );
    Object.assign(config.compilerOptions.paths, {
      "@supacloud/app/core": [join(repo, "packages/app/src/core.ts")],
      "@supacloud/app/execution": [join(repo, "packages/app/src/execution.ts")],
      "@supacloud/app/runtime": [join(repo, "packages/app/src/runtime.ts")],
      "@supacloud/db/bun": [join(repo, "packages/db/src/command-bun.ts")],
      "@supacloud/contracts/client": [join(repo, "packages/contracts/src/client.ts")],
      "@supacloud/js": [join(repo, "packages/supacloud-js/src/index.ts")],
      "@supacloud/js/contracts": [join(repo, "packages/supacloud-js/src/contracts.ts")],
      "@supabase/supabase-js": [join(repo, "packages/supacloud-js/node_modules/@supabase/supabase-js")],
      "drizzle-orm": [join(repo, "packages/db/node_modules/drizzle-orm")],
      "drizzle-orm/*": [join(repo, "packages/db/node_modules/drizzle-orm/*")],
      "#starter-postgres": [join(repo, "scripts/lib/starter-postgres.ts")],
      "#starter-bootstrap": [join(repo, "packages/supacloud-lite/src/runtime/db/bootstrap.ts")],
      "#starter-runtime": [join(repo, "packages/supacloud-lite/src/runtime/db/emulated.ts")],
      "@supacloud/compiler": [join(repo, "packages/cli/node_modules/@supacloud/compiler/dist/index.js")],
    });
    await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
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
