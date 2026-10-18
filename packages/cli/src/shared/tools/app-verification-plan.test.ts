import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ApplicationGraph } from "@supacloud/compiler";
import { createVerificationPlan } from "./app-verification-plan";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "verification-plan-"));
  roots.push(root);
  await mkdir(join(root, "src/health"), { recursive: true });
  await mkdir(join(root, "src/other"), { recursive: true });
  await writeFile(join(root, "src/health/health.ts"), "");
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

test("verification resolves job service keys and gives exact module names precedence", async () => {
  const { root, graph } = await fixture();
  graph.modules[0]!.jobs = [{
    className: "VerifyJob", name: "review.verify", serviceKey: "review-verifier", scope: "job",
  }];
  expect((await createVerificationPlan(root, graph, "review-verifier")).target).toBe("health");
  graph.modules.push({
    ...graph.modules[0]!, name: "other", file: "src/other/other.ts",
    jobs: [{ className: "OtherJob", name: "health", serviceKey: "review-verifier", scope: "job" }],
  });
  const exact = await createVerificationPlan(root, graph, "health");
  expect(exact.target).toBe("health");
  expect(exact.tests).toEqual(["src/health/health.test.ts"]);
  await expect(createVerificationPlan(root, graph, "review-verifier")).rejects.toThrow("unambiguous");
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

test("parent-directory sources cannot enumerate a sibling project using native path separators", async () => {
  const { root, graph } = await fixture();
  const outside = await fixture();
  graph.modules[0]!.file = relative(root, join(outside.root, "src/health/health.ts"));
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.ready).toBe(false);
  expect(plan.tests).toEqual([]);
  expect(plan.manual).toContain("A source file is outside the project; select its owning project explicitly");
});

test("separate command sources are included and uncovered directories remain explicit", async () => {
  const { root, graph } = await fixture();
  await mkdir(join(root, "src/commands"));
  await writeFile(join(root, "src/commands/approve.ts"), "");
  graph.moduleHandlerFiles = { health: ["src/commands/approve.ts"] };
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.files).toContain("src/commands/approve.ts");
  expect(plan.ready).toBe(false);
  expect(plan.manual).toContain("No colocated tests for source directory: src/commands");
  expect(plan.coverage).toContainEqual({
    directory: "src/commands", tests: [], basis: "colocated-not-proven",
  });
  await writeFile(join(root, "src/commands/approve.test.ts"), "");
  const covered = await createVerificationPlan(root, graph, "health");
  expect(covered.ready).toBe(true);
  expect(covered.tests).toEqual(["src/commands/approve.test.ts", "src/health/health.test.ts"]);
  expect(covered.limitations).toContain("Colocation selects candidates; it does not prove behavioral coverage");
});

test("feature specifications are included in the bounded verification files and coverage", async () => {
  const { root, graph } = await fixture();
  await mkdir(join(root, "src/health/state"));
  await writeFile(join(root, "src/health/state/review.ts"), "");
  await writeFile(join(root, "src/health/state/review.test.ts"), "");
  graph.modules[0]!.featureSpec = {
    name: "review", states: ["draft", "approved"], transitions: [], file: "src/health/state/review.ts", line: 1,
  };
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.files).toContain("src/health/state/review.ts");
  expect(plan.tests).toContain("src/health/state/review.test.ts");
  expect(plan.coverage).toContainEqual({
    directory: "src/health/state", tests: ["src/health/state/review.test.ts"], basis: "colocated-not-proven",
  });
  expect(plan.ready).toBe(true);
});

test("missing source directories produce a manual gap, not an unstructured failure", async () => {
  const { root, graph } = await fixture();
  graph.moduleHandlerFiles = { health: ["src/missing/command.ts"] };
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.ready).toBe(false);
  expect(plan.manual).toContain("Source file is missing: src/missing/command.ts");
});

test("a source file symlink cannot authorize another project's edit or test paths", async () => {
  const { root, graph } = await fixture();
  const outside = await fixture();
  await rm(join(root, "src/health/health.ts"));
  await symlink(join(outside.root, "src/health/health.ts"), join(root, "src/health/health.ts"));
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.ready).toBe(false);
  expect(plan.files).toEqual([]);
  expect(plan.tests).toEqual([]);
  expect(plan.manual).toContain("A source file is outside the project; select its owning project explicitly");
  expect(JSON.stringify(plan)).not.toContain(outside.root);
});

test("a missing source cannot be marked ready merely because its directory has tests", async () => {
  const { root, graph } = await fixture();
  await rm(join(root, "src/health/health.ts"));
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.ready).toBe(false);
  expect(plan.files).toEqual([]);
  expect(plan.tests).toEqual([]);
  expect(plan.manual).toContain("Source file is missing: src/health/health.ts");
});

test("a directory cannot be advertised as an editable source file", async () => {
  const { root, graph } = await fixture();
  await rm(join(root, "src/health/health.ts"));
  await mkdir(join(root, "src/health/health.ts"));
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.ready).toBe(false);
  expect(plan.files).toEqual([]);
  expect(plan.manual).toContain("Source is not a regular file: src/health/health.ts");
});

test("an internal file alias selects the canonical source and its colocated tests", async () => {
  const { root, graph } = await fixture();
  await writeFile(join(root, "src/other/implementation.ts"), "");
  await rm(join(root, "src/health/health.ts"));
  await symlink(join(root, "src/other/implementation.ts"), join(root, "src/health/health.ts"));
  const plan = await createVerificationPlan(root, graph, "health");
  expect(plan.ready).toBe(true);
  expect(plan.files).toEqual(["src/other/implementation.ts"]);
  expect(plan.tests).toEqual(["src/other/unrelated.test.ts"]);
  expect(plan.executed).toBe(false);
});
