import { expect, test } from "bun:test";

interface WorkflowJob {
  env?: Record<string, string>;
  steps: { name?: string; run?: string }[];
}

test("native activation CI installs and selects PostgreSQL 18 explicitly", async () => {
  const contents = await Bun.file(new URL("../../.github/workflows/management-api.yml", import.meta.url)).text();
  const workflow = Bun.YAML.parse(contents) as { jobs: Record<string, WorkflowJob> };
  const job = workflow.jobs["application-activation-native"];
  if (!job) throw new Error("Native activation job missing");
  const install = job.steps.find(step => step.name === "Install local test dependencies")?.run;
  const verify = job.steps.find(step => step.name === "Verify activation journal on an owned cluster")?.run;
  expect(install).toContain("sudo apt-get install -y postgresql-18");
  expect(install).toContain("apt.postgresql.org/pub/repos/apt");
  expect(job.env?.["SUPACLOUD_STARTER_POSTGRES_BIN"]).toBe("/usr/lib/postgresql/18/bin");
  expect(verify).toContain('"$SUPACLOUD_STARTER_POSTGRES_BIN/postgres" --version');
  expect(verify).toContain("bun --no-env-file test scripts/lib/application-activation-native.test.ts scripts/lib/application-migrations-native.test.ts");
  expect(verify).not.toContain("/usr/lib/postgresql/*/bin");
  expect(verify).not.toContain("postgres_bin=");
});
