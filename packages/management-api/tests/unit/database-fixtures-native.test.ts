// @supacloud-test-isolate
import { test } from "bun:test";
import { join } from "node:path";
import { withNativePostgres } from "../helpers/native-postgres";

async function runFixtureCommand(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: join(import.meta.dir, "../.."),
    env,
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(30_000),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Native database fixtures failed (${exitCode})\n${stdout}\n${stderr}`);
}

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native typed read-back regressions exercise initialized PostgreSQL",
  async () => withNativePostgres(async (_database, url, name) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: url,
      POSTGRES_CONTAINER: name,
      SECRETS_ENCRYPTION_KEY: "native-migration-fixture-0123456789abcdef",
    };
    for (const key of ["CI", "GITHUB_ACTIONS", "TEST_FIXED_JWT_SECRET",
      "SUPACLOUD_EXPECTED_CONTROL_PLANE_DATABASE_FINGERPRINT",
      "SUPACLOUD_EXPECTED_CONTROL_PLANE_DATABASE_SNAPSHOT"]) {
      delete env[key];
    }
    await runFixtureCommand([
      "-e", 'import { initDatabase } from "./src/db/init"; await initDatabase();',
    ], env);
    await runFixtureCommand([
      "test",
      "tests/integration/project-mutation-migration.test.ts",
      "tests/integration/project-organization-array-binding.test.ts",
      "tests/integration/project-webhook-array-binding.test.ts",
      "tests/integration/storage-bucket-array-binding.test.ts",
      "tests/integration/storage-bucket-cas.test.ts",
      "tests/integration/realtime-auto-attach-trigger.test.ts",
      "tests/integration/realtime-notify-payload.test.ts",
    ], env);
  }),
  60_000,
);
