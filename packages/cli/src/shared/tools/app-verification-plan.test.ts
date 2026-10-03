import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationGraph } from "@supacloud/compiler";
import { createVerificationPlan } from "./app-verification-plan";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "verification-plan-"));
  roots.push(root);
  await mkdir(join(root, "src/health"), { recursive: true });
  await mkdir(join(root, "src/other"), { recursive: true });
  await writeFile(join(root, "src/health/health.test.ts"), "");
  await writeFile(join(root, "src/other/unrelated.test.ts"), "");
  const graph: ApplicationGraph = {
    externalTokens: [],
    modules: [{
      name: "health", className: "HealthModule", file: "src/health/health.ts", line: 1,
      imports: [], providers: [], controllers: [], commands: [], queries: [], exports: [],
    }],
  };
  return { root, graph };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("verification selects one module's local tests and never executes or broadens them", async () => {
  const { root, graph } = await fixture();
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.ready).toBe(true);
  expect(plan.tests).toEqual(["src/health/health.test.ts"]);
  expect(plan.commands).toEqual([["bun", "test", "./src/health/health.test.ts"], ["git", "diff", "--check"]]);
  expect(plan.executed).toBe(false);
});

test("missing and ambiguous targets cannot silently select the whole repository", async () => {
  const { root, graph } = await fixture();
  await expect(createVerificationPlan(root, graph, "")).rejects.toThrow("unambiguous");
  graph.modules.push({ ...graph.modules[0]! });
  await expect(createVerificationPlan(root, graph, "health")).rejects.toThrow("unambiguous");
});

test("compiler paths relative to a configured source root resolve inside the project", async () => {
  const { root, graph } = await fixture();
  graph.modules[0]!.file = "health/health.ts";
  const plan = await createVerificationPlan(root, graph, "health", join(root, "src"));
  expect(plan.ready).toBe(true);
  expect(plan.tests).toEqual(["src/health/health.test.ts"]);
});

test("missing tests produce manual action instead of a full-suite fallback", async () => {
  const { root, graph } = await fixture();
  await rm(join(root, "src/health/health.test.ts"));
  const plan = await createVerificationPlan(root, graph, "HealthModule");
  expect(plan.ready).toBe(false);
  expect(plan.tests).toEqual([]);
  expect(plan.commands).toEqual([["git", "diff", "--check"]]);
});

test("symlinked source directories cannot enumerate another project", async () => {
  const { root, graph } = await fixture();
  const outside = await fixture();
  await symlink(join(outside.root, "src/health"), join(root, "linked"));
  graph.modules[0]!.file = "linked/health.ts";
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.ready).toBe(false);
  expect(plan.tests).toEqual([]);
});
