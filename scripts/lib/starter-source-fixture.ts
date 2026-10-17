import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { appStarterFiles } from "../../packages/cli/src/shared/tools/app-starter";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected starter compiler configuration");
  return value as Record<string, unknown>;
}

/** Source-only acceptance, deliberately distinct from the npm consumer gate. */
export async function prepareStarterSourceFixture(root: string): Promise<void> {
  const repo = resolve(import.meta.dir, "../..");
  for (const [path, content] of Object.entries(appStarterFiles("recovery-test"))) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await symlink(join(repo, "packages/elysia/node_modules"), join(root, "node_modules"), "dir");
  const config = record(JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8")));
  const compilerOptions = record(config["compilerOptions"]);
  const paths: Record<string, string[]> = Object.fromEntries(
    ["app", "elysia", "commands", "contracts", "db", "query"].map(name =>
      [`@supacloud/${name}`, [join(repo, "packages", name, "src/index.ts")]]),
  );
  Object.assign(paths, {
    "@supacloud/app/core": [join(repo, "packages/app/src/core.ts")],
    "@supacloud/app/execution": [join(repo, "packages/app/src/execution.ts")],
    "@supacloud/app/runtime": [join(repo, "packages/app/src/runtime.ts")],
    "@supacloud/db/bun": [join(repo, "packages/db/src/command-bun.ts")],
    "@supacloud/contracts/client": [join(repo, "packages/contracts/src/client.ts")],
    "@supacloud/contracts/browser": [join(repo, "packages/contracts/src/browser.ts")],
    "@supacloud/js": [join(repo, "packages/supacloud-js/src/index.ts")],
    "@supacloud/js/contracts": [join(repo, "packages/supacloud-js/src/contracts.ts")],
    "@supabase/supabase-js": [join(repo, "packages/cli/node_modules/@supabase/supabase-js")],
    "drizzle-orm": [join(repo, "packages/db/node_modules/drizzle-orm")],
    "drizzle-orm/*": [join(repo, "packages/db/node_modules/drizzle-orm/*")],
    "#starter-postgres": [join(repo, "scripts/lib/starter-postgres.ts")],
    "#starter-lite": [join(repo, "scripts/lib/starter-lite.ts")],
    "#starter-svadmin": [join(repo, "scripts/lib/starter-svadmin.ts")],
    "#starter-bootstrap": [join(repo, "packages/supacloud-lite/src/runtime/db/bootstrap.ts")],
    "#starter-runtime": [join(repo, "packages/supacloud-lite/src/runtime/db/emulated.ts")],
    "@supacloud/compiler": [join(repo, "packages/cli/node_modules/@supacloud/compiler/dist/index.js")],
  });
  compilerOptions["paths"] = paths;
  await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
}
