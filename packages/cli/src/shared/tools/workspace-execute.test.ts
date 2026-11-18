import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createWorkspacePlan } from "./workspace-plan";
import { createHttpWorkspaceDeliveryClient, type WorkspaceHttp } from "./workspace-delivery-http";
import { executeWorkspace, workspaceMutationId, type WorkspaceArtifact, type WorkspaceDeliveryClient, type WorkspaceTargetStatus } from "./workspace-execute";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const revision = "a".repeat(40);
function config() {
  return {
    schema: "supacloud.workspace.v1", repository: "github.com/acme/store",
    shared_paths: ["packages/*"],
    applications: [
      app("storefront", "apps/storefront", { "@acme/ui": "workspace:*" }),
      app("admin", "apps/admin", { "@acme/ui": "workspace:*" }),
      app("worker", "apps/worker", { "@acme/jobs": "workspace:*" }),
    ],
  };
}
function app(id: string, root: string, dependencies: Record<string, string>) {
  return {
    id, root, build: "bun run build",
    environments: {
      staging: { project_ref: `${id.slice(0, 4)}-stg`, application_id: id },
      production: { project_ref: `${id.slice(0, 4)}-prd`, application_id: id },
    },
    dependencies,
  };
}

async function fixture(changed: string[]): Promise<{ root: string; digest: string }> {
  const root = await mkdtemp(join(tmpdir(), "workspace-execute-"));
  roots.push(root);
  const document = config();
  await writeTree(root, {
    "supacloud.workspace.json": `${JSON.stringify({ schema: document.schema, repository: document.repository, shared_paths: document.shared_paths, applications: document.applications.map(({ dependencies: _dependencies, ...application }) => application) })}\n`,
    "apps/storefront/package.json": JSON.stringify({ name: "@acme/storefront", dependencies: document.applications[0]!.dependencies }),
    "apps/storefront/src/page.ts": "export const page = 1;\n",
    "apps/admin/package.json": JSON.stringify({ name: "@acme/admin", dependencies: document.applications[1]!.dependencies }),
    "apps/admin/src/page.ts": "export const admin = 1;\n",
    "apps/worker/package.json": JSON.stringify({ name: "@acme/worker", dependencies: document.applications[2]!.dependencies }),
    "apps/worker/src/index.ts": "export const worker = 1;\n",
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", dependencies: { "@acme/tokens": "workspace:*" } }),
    "packages/ui/src/index.ts": "export const ui = 1;\n",
    "packages/tokens/package.json": JSON.stringify({ name: "@acme/tokens" }),
    "packages/tokens/src/index.ts": "export const token = 1;\n",
    "packages/jobs/package.json": JSON.stringify({ name: "@acme/jobs" }),
    "packages/jobs/src/index.ts": "export const job = 1;\n",
  });
  return { root, digest: createHash("sha256").update(await (await import("node:fs/promises")).readFile(join(root, "supacloud.workspace.json"))).digest("hex") };
}

async function writeTree(root: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), contents);
  }
}

function fakeClient(): WorkspaceDeliveryClient & {
    builds: string[]; uploads: string[]; deploys: string[]; transfers: string[]; reconciles: string[];
    fail(projectRef: string, applicationId: string, mutationId: string, status: WorkspaceTargetStatus): void;
} {
  const releases = new Map<string, WorkspaceArtifact[]>();
  const deployments = new Map<string, WorkspaceTargetStatus>();
  const client = {
    builds: [] as string[], uploads: [] as string[], deploys: [] as string[], transfers: [] as string[], reconciles: [] as string[],
    async build(input: { applicationId: string }) { client.builds.push(input.applicationId); return { manifestSha256: createHash("sha256").update(input.applicationId).digest("hex") }; },
    async listReleases(projectRef: string, applicationId: string) { return releases.get(`${projectRef}/${applicationId}`) ?? []; },
    async upload(input: { projectRef: string; applicationId: string; manifestSha256: string }) {
      client.uploads.push(`${input.projectRef}/${input.applicationId}`);
      const artifact = { releaseId: createHash("sha256").update(`${input.projectRef}/${input.manifestSha256}`).digest("hex"), manifestSha256: input.manifestSha256 };
      releases.set(`${input.projectRef}/${input.applicationId}`, [...(releases.get(`${input.projectRef}/${input.applicationId}`) ?? []), artifact]);
      return artifact;
    },
    async transfer(input: { projectRef: string; applicationId: string; manifestSha256: string; sourceReleaseId: string }) {
      client.transfers.push(`${input.projectRef}/${input.applicationId}`);
      const artifact = { releaseId: createHash("sha256").update(`transfer/${input.projectRef}/${input.manifestSha256}`).digest("hex"), manifestSha256: input.manifestSha256 };
      releases.set(`${input.projectRef}/${input.applicationId}`, [artifact]);
      return { ...artifact, replayed: false };
    },
    async deploy(input: { projectRef: string; applicationId: string; mutationId: string }) {
      client.deploys.push(`${input.projectRef}/${input.applicationId}/${input.mutationId}`);
      const key = `${input.projectRef}/${input.applicationId}/${input.mutationId}`;
      const status = deployments.get(key) ?? "accepted";
      return { mutationId: input.mutationId, status, replayed: false };
    },
    async readDeploy(input: { projectRef: string; applicationId: string; mutationId: string }) {
      return { mutationId: input.mutationId, status: deployments.get(`${input.projectRef}/${input.applicationId}/${input.mutationId}`) ?? "absent" };
    },
    async reconcileDeploy(input: { mutationId: string; projectRef: string; applicationId: string }) {
      client.reconciles.push(input.mutationId);
      return { mutationId: input.mutationId, status: "unknown" as const };
    },
    async promote(input: { mutationId: string; projectRef: string; applicationId: string }) {
      client.deploys.push(`promote/${input.projectRef}/${input.applicationId}`);
      return { mutationId: input.mutationId, status: "accepted" as const, replayed: false };
    },
    async reconcilePromotion(input: { mutationId: string }) { client.reconciles.push(input.mutationId); return { mutationId: input.mutationId, status: "unknown" as const }; },
    async observe(input: { projectRef: string; applicationId: string; environmentId: string }) {
      return { project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId, release_id: null, manifest_sha256: null, status: "absent" as const, failure: null, mutation_id: null, authoritative: false as const };
    },
    fail(projectRef: string, applicationId: string, mutationId: string, status: WorkspaceTargetStatus) { deployments.set(`${projectRef}/${applicationId}/${mutationId}`, status); },
  };
  return client;
}

async function ready(root: string, environment: string, changed: string[]) {
  const plan = await createWorkspacePlan({ root, environment, changedFiles: changed });
  return plan;
}

test("an application change builds and deploys only that staging project", async () => {
  const { root, digest } = await fixture(["apps/storefront/src/page.ts"]);
  const plan = await ready(root, "staging", ["apps/storefront/src/page.ts"]);
  const client = fakeClient();
  const result = await executeWorkspace({ root, operation: "execute", environment: "staging", changedFiles: ["apps/storefront/src/page.ts"], execute: true, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  expect(result.status).toBe("completed");
  expect(client.builds).toEqual(["storefront"]);
  expect(client.uploads).toEqual(["stor-stg/storefront"]);
  expect(client.deploys.some(call => call.startsWith("stor-prd") || call.includes("admin") || call.includes("worker"))).toBe(false);
  expect(result.targets.map(target => target.project_ref)).toEqual(["stor-stg"]);
});

test("a shared package change builds transitive dependents once and promote reuses the release", async () => {
  const changed = ["packages/tokens/src/index.ts"];
  const { root, digest } = await fixture(changed);
  const staging = await ready(root, "staging", changed);
  const client = fakeClient();
  const executed = await executeWorkspace({ root, operation: "execute", environment: "staging", changedFiles: changed, execute: true, planSha256: staging.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  expect(client.builds.sort()).toEqual(["admin", "storefront"]);
  expect(executed.builds.every(build => build.count === 1)).toBe(true);
  const production = await ready(root, "production", changed);
  const promoted = await executeWorkspace({ root, operation: "promote", environment: "production", changedFiles: changed, execute: true, planSha256: production.plan_sha256, sourceRevision: revision, headRevision: revision, approvalId: "a".repeat(64), configurationId: "11234567-89ab-4def-8123-456789abcdef", sourceEnvironment: "staging", configDigest: digest, client });
  expect(client.builds).toEqual(["admin", "storefront"]);
  expect(client.transfers.sort()).toEqual(["admi-prd/admin", "stor-prd/storefront"]);
  expect(promoted.builds).toEqual([]);
  expect(promoted.targets.every(target => target.reused_build)).toBe(true);
});

test("a failed target retries the same mutation without another build and an unknown result is only reconciled", async () => {
  const changed = ["apps/worker/src/index.ts"];
  const { root, digest } = await fixture(changed);
  const plan = await ready(root, "staging", changed);
  const client = fakeClient();
  const first = await executeWorkspace({ root, operation: "execute", environment: "staging", changedFiles: changed, execute: true, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  const mutationId = first.targets[0]!.mutation_id!;
  client.fail("work-stg", "worker", mutationId, "failed");
  const retried = await executeWorkspace({ root, operation: "retry", environment: "staging", changedFiles: changed, execute: true, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, mutationId, configDigest: digest, client });
  expect(client.builds).toEqual(["worker"]);
  expect(retried.targets[0]?.mutation_id).toBe(mutationId);
  expect(client.deploys.filter(call => call.includes(mutationId))).toHaveLength(2);
  client.fail("work-stg", "worker", mutationId, "unknown");
  const unknown = await executeWorkspace({ root, operation: "retry", environment: "staging", changedFiles: changed, execute: true, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, mutationId, configDigest: digest, client });
  expect(unknown.status).toBe("unknown");
  expect(client.reconciles).toEqual([mutationId]);
  expect(client.deploys.filter(call => call.includes(mutationId))).toHaveLength(2);
  expect(workspaceMutationId(["deploy", plan.plan_sha256, "worker", "staging", first.targets[0]!.release_id!])).toBe(mutationId);
});

test("stale plans, missing approval, and opt-in false do not write", async () => {
  const changed = ["apps/storefront/src/page.ts"];
  const { root, digest } = await fixture(changed);
  const plan = await ready(root, "staging", changed);
  const client = fakeClient();
  const optedOut = await executeWorkspace({ root, operation: "execute", environment: "staging", changedFiles: changed, execute: false, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  const stale = await executeWorkspace({ root, operation: "execute", environment: "staging", changedFiles: changed, execute: true, planSha256: "0".repeat(64), sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  const production = await ready(root, "production", changed);
  const unapproved = await executeWorkspace({ root, operation: "execute", environment: "production", changedFiles: changed, execute: true, planSha256: production.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  expect(optedOut.execution_performed).toBe(false);
  expect(stale.diagnostics[0]?.code).toBe("stale-plan");
  expect(unapproved.targets[0]?.status).toBe("skipped");
  expect(client.deploys).toEqual([]);
});

test("promotion HTTP reads the existing plan and does not post when that read fails", async () => {
  const calls: string[] = [];
  const http: WorkspaceHttp = {
    async get(path) { calls.push(`GET ${path}`); return { ok: false, status: 503, data: null, transportError: true }; },
    async post(path) { calls.push(`POST ${path}`); return { ok: true, status: 200, data: {} }; },
  };
  const client = createHttpWorkspaceDeliveryClient(http, async () => ({ manifestSha256: "a".repeat(64) }));
  const result = await client.promote({
    projectRef: "store-prd", applicationId: "storefront", environmentId: "production", releaseId: "a".repeat(64),
    manifestSha256: "b".repeat(64), mutationId: "01234567-89ab-4def-8123-456789abcdef", approvalId: "c".repeat(64),
    repository: "github.com/acme/store", configDigest: "d".repeat(64), sourceRevision: revision, workspacePlanSha256: "e".repeat(64),
    configurationId: "11234567-89ab-4def-8123-456789abcdef", activationId: null, expectedActivationId: null,
    sourceProjectRef: "store-stg", sourceEnvironmentId: "staging", sourceReleaseId: "f".repeat(64),
  });
  expect(result.status).toBe("unknown");
  expect(calls.some(call => call.startsWith("POST"))).toBe(false);
  expect(calls[0]).toContain("/promotion-plan?");
});

test("repository status reports every binding and does not mark observations authoritative", async () => {
  const { root, digest } = await fixture([]);
  const plan = await ready(root, "staging", []);
  const client = fakeClient();
  const status = await executeWorkspace({ root, operation: "status", environment: "staging", changedFiles: [], execute: false, configDigest: digest, client });
  expect(status.execution_performed).toBe(false);
  expect(status.observations.map(item => `${item.application_id}:${item.environment_id}:${item.project_ref}`).sort()).toEqual([
    "admin:production:admi-prd", "admin:staging:admi-stg", "storefront:production:stor-prd", "storefront:staging:stor-stg", "worker:production:work-prd", "worker:staging:work-stg",
  ]);
  expect(status.observations.every(item => item.authoritative === false)).toBe(true);
  expect(plan.repository).toBe("github.com/acme/store");
});
