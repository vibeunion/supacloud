import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFixtureProject } from "./fixtures/helpers";
import { RUNTIME_SOURCE } from "./fixtures/runtime-source";
import { PreviewFixError, runPreviewFixLoop } from "./preview-fix-loop";

const previewId = "12345678-1234-4234-8234-123456789abc";
const branchRef = "pv123456781234423482";
const scope = {
  previewId,
  projectRef: "demo",
  applicationId: "api",
  environmentId: "test",
  property: "transaction" as const,
  value: "required" as const,
};

const source = `import { Command, Module } from "./runtime";

@Command({
  name: "case.approve",
  permission: "case.approve",
  transaction: "requried",
  audit: "case.approved",
  idempotency: "required",
})
export class Approve {
  execute(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ name: "case", commands: [Approve] })
export class CaseModule {}
`;

function files(): Record<string, string> {
  return {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { experimentalDecorators: true },
      include: ["src/**/*.ts"],
    }),
    "src/runtime.ts": RUNTIME_SOURCE,
    "src/case.module.ts": source,
  };
}

async function roots() {
  const parent = await mkdtemp(join(tmpdir(), "preview-fix-loop-"));
  const productionRoot = join(parent, "production");
  const previewRoot = join(parent, "previews", branchRef);
  await writeFixtureProject(productionRoot, files());
  await writeFixtureProject(previewRoot, files());
  return { parent, productionRoot, previewRoot };
}

test("preview fix loop records change, diagnosis, invoke, and timeline without writing production", async () => {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const { parent, productionRoot, previewRoot } = await roots();
  const productionBefore = await readFile(join(productionRoot, "src/case.module.ts"), "utf8");
  try {
    const child = Bun.spawn([
      process.execPath, "--no-env-file", cli, "preview-fix",
      "--production", productionRoot,
      "--preview", previewRoot,
      "--preview-id", previewId,
      "--project-ref", scope.projectRef,
      "--application-id", scope.applicationId,
      "--environment-id", scope.environmentId,
      "--property", "transaction",
      "--value", "required",
      "--json",
    ], {
      cwd: parent,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 60_000);
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer));
    expect(status, stderr).toBe(0);
    const receipt = JSON.parse(stdout);
    expect(receipt).toMatchObject({
      schema: "supacloud.preview-deploy-receipt.v1",
      deployed: false,
      published: false,
      live: false,
      target: "preview",
      preview_id: previewId,
      branch_ref: branchRef,
      status: "recorded",
      graph: { modules: ["case"], command: "case.approve", transaction: "required" },
      change: { file: "src/case.module.ts", written: true },
      diagnosis: { code: "invalid-command-mode", errorCode: "SC4012", file: "src/case.module.ts" },
      test: { operation: "case.approve", ok: true },
      timeline: { handler: "succeeded", failed: false, operation: "case.approve" },
      production: { written: false, approval: "required", graphRead: true },
    });
    expect(receipt.artifact_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.timeline.missingStages).toEqual(expect.arrayContaining(["authorize", "audit"]));
    const saved = JSON.parse(await readFile(join(previewRoot, "preview-deploy-receipt.json"), "utf8"));
    expect(saved).toEqual(receipt);
    const events = JSON.parse(await readFile(join(previewRoot, "preview-execution-events.json"), "utf8"));
    expect(events.events.map((event: { stage: string; phase: string }) => [event.stage, event.phase])).toEqual([
      ["handler", "started"],
      ["handler", "succeeded"],
    ]);
    const previewSource = await readFile(join(previewRoot, "src/case.module.ts"), "utf8");
    expect(previewSource).toContain('transaction: "required"');
    expect(previewSource).not.toContain("requried");
    expect(await readFile(join(productionRoot, "src/case.module.ts"), "utf8")).toBe(productionBefore);
    expect(productionBefore).toContain("requried");
    await expect(readFile(join(productionRoot, "preview-deploy-receipt.json"), "utf8")).rejects.toThrow();
    await expect(readFile(join(productionRoot, "generated", "application.ts"), "utf8")).rejects.toThrow();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}, 60_000);

test("production is not a writable preview and a missing policy is refused", async () => {
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const { parent, productionRoot } = await roots();
  const named = join(parent, branchRef);
  await writeFixtureProject(named, files());
  const before = await readFile(join(named, "src/case.module.ts"), "utf8");
  try {
    await expect(runPreviewFixLoop({
      ...scope, productionRoot, previewRoot: productionRoot,
    })).rejects.toThrow(PreviewFixError);
    await expect(runPreviewFixLoop({
      ...scope, productionRoot: named, previewRoot: named,
    })).rejects.toThrow(PreviewFixError);
    const child = Bun.spawn([
      process.execPath, "--no-env-file", cli, "preview-fix",
      "--production", productionRoot,
      "--preview", named,
      "--preview-id", previewId,
      "--project-ref", scope.projectRef,
      "--application-id", scope.applicationId,
      "--environment-id", scope.environmentId,
      "--property", "transaction",
      "--json",
    ], {
      cwd: parent,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("PREVIEW_FIX_POLICY_REQUIRED");
    expect(stdout).toBe("");
    expect(await readFile(join(named, "src/case.module.ts"), "utf8")).toBe(before);
    expect(await readFile(join(productionRoot, "src/case.module.ts"), "utf8")).toBe(before);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
