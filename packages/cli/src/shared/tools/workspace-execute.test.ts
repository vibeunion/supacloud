import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createWorkspacePlan, readWorkspaceHead } from "./workspace-plan";
import { createHttpWorkspaceDeliveryClient, type WorkspaceHttp } from "./workspace-delivery-http";
import { executeWorkspace, runWorkspaceCommand, workspaceMutationId, type ReleaseOutcome, type WorkspaceApprovalView, type WorkspaceArtifact, type WorkspaceDeliveryClient, type WorkspaceTargetStatus } from "./workspace-execute";
import { createFrontendArchive } from "./deploy-tools";

const git = promisify(execFile);

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
    unavailable: boolean;
    promoteStatus: WorkspaceTargetStatus;
    fail(projectRef: string, applicationId: string, mutationId: string, status: WorkspaceTargetStatus): void;
    seed(projectRef: string, applicationId: string, artifact: WorkspaceArtifact): void;
    grant(approval: WorkspaceApprovalView): void;
} {
  const releases = new Map<string, WorkspaceArtifact[]>();
  const deployments = new Map<string, ReleaseOutcome>();
  const approvals = new Map<string, WorkspaceApprovalView>();
  const client = {
    builds: [] as string[], uploads: [] as string[], deploys: [] as string[], transfers: [] as string[], reconciles: [] as string[],
    unavailable: false, promoteStatus: "accepted" as WorkspaceTargetStatus,
    async build(input: { applicationId: string }) { client.builds.push(input.applicationId); return { manifestSha256: createHash("sha256").update(input.applicationId).digest("hex") }; },
    async listReleases(projectRef: string, applicationId: string) {
      if (client.unavailable) return { availability: "unavailable" as const };
      return { availability: "available" as const, releases: releases.get(`${projectRef}/${applicationId}`) ?? [] };
    },
    async upload(input: { projectRef: string; applicationId: string; manifestSha256: string }) {
      client.uploads.push(`${input.projectRef}/${input.applicationId}`);
      const artifact = { releaseId: createHash("sha256").update(`${input.projectRef}/${input.manifestSha256}`).digest("hex"), manifestSha256: input.manifestSha256 };
      releases.set(`${input.projectRef}/${input.applicationId}`, [artifact, ...(releases.get(`${input.projectRef}/${input.applicationId}`) ?? [])]);
      return artifact;
    },
    async transfer(input: { projectRef: string; applicationId: string; manifestSha256: string; sourceReleaseId: string }) {
      client.transfers.push(`${input.sourceReleaseId}:${input.projectRef}/${input.applicationId}`);
      const artifact = { releaseId: createHash("sha256").update(`transfer/${input.projectRef}/${input.manifestSha256}`).digest("hex"), manifestSha256: input.manifestSha256 };
      releases.set(`${input.projectRef}/${input.applicationId}`, [artifact]);
      return { ...artifact, replayed: false };
    },
    async deploy(input: { projectRef: string; applicationId: string; mutationId: string; releaseId: string; manifestSha256: string }) {
      client.deploys.push(`${input.projectRef}/${input.applicationId}/${input.mutationId}`);
      const key = `${input.projectRef}/${input.applicationId}/${input.mutationId}`;
      const status = deployments.get(key)?.status ?? "accepted";
      deployments.set(key, { mutationId: input.mutationId, status, releaseId: input.releaseId, manifestSha256: input.manifestSha256 });
      return { mutationId: input.mutationId, status, replayed: false };
    },
    async readDeploy(input: { projectRef: string; applicationId: string; mutationId: string }): Promise<ReleaseOutcome> {
      return deployments.get(`${input.projectRef}/${input.applicationId}/${input.mutationId}`) ?? { mutationId: input.mutationId, status: "absent", releaseId: null, manifestSha256: null };
    },
    async reconcileDeploy(input: { mutationId: string }): Promise<ReleaseOutcome> {
      client.reconciles.push(input.mutationId);
      return { mutationId: input.mutationId, status: "unknown", releaseId: null, manifestSha256: null };
    },
    async promote(input: { mutationId: string; projectRef: string; applicationId: string }) {
      client.deploys.push(`promote/${input.projectRef}/${input.applicationId}`);
      return { mutationId: input.mutationId, status: client.promoteStatus, replayed: false };
    },
    async reconcilePromotion(input: { mutationId: string }): Promise<ReleaseOutcome> {
      client.reconciles.push(input.mutationId);
      return { mutationId: input.mutationId, status: "unknown", releaseId: null, manifestSha256: null };
    },
    async readApproval(input: { projectRef: string; approvalId: string }) {
      return approvals.get(`${input.projectRef}/${input.approvalId}`) ?? { availability: "missing" as const };
    },
    async observe(input: { projectRef: string; applicationId: string; environmentId: string }) {
      return { project_ref: input.projectRef, application_id: input.applicationId, environment_id: input.environmentId, release_id: null, manifest_sha256: null, status: "absent" as const, failure: null, mutation_id: null, authoritative: false as const };
    },
    fail(projectRef: string, applicationId: string, mutationId: string, status: WorkspaceTargetStatus) {
      const key = `${projectRef}/${applicationId}/${mutationId}`;
      const current = deployments.get(key);
      deployments.set(key, { mutationId, status, releaseId: current?.releaseId ?? null, manifestSha256: current?.manifestSha256 ?? null });
    },
    seed(projectRef: string, applicationId: string, artifact: WorkspaceArtifact) {
      releases.set(`${projectRef}/${applicationId}`, [artifact, ...(releases.get(`${projectRef}/${applicationId}`) ?? [])]);
    },
    grant(approval: WorkspaceApprovalView) { approvals.set(`${approval.projectRef}/${"a".repeat(64)}`, approval); },
  };
  return client;
}

async function ready(root: string, environment: string, changed: string[]) {
  const plan = await createWorkspacePlan({ root, environment, changedFiles: changed });
  return plan;
}

const staticWorkspace = {
  schema: "supacloud.workspace.v1",
  repository: "github.com/acme/sites",
  shared_paths: [],
  applications: ["official", "landing"].map(id => ({
    id, root: id, build: "bun run build",
    environments: { production: { project_ref: "sites", frontend_deployment_id: `${id}-web` } },
  })),
};

async function staticFixture() {
  const root = await mkdtemp(join(tmpdir(), "workspace-static-"));
  roots.push(root);
  await writeTree(root, {
    "supacloud.workspace.json": JSON.stringify(staticWorkspace),
    ".gitignore": "dist/\n",
    "official/index.html": "<h1>Old</h1>",
    "landing/index.html": "<h1>Landing</h1>",
    "official/supacloud.json": JSON.stringify({ frontend: { id: "official-web", outputDirectory: "dist" } }),
    "landing/supacloud.json": JSON.stringify({ frontend: { id: "landing-web", outputDirectory: "dist" } }),
  });
  await git("git", ["init", "-q"], { cwd: root });
  async function commit() {
    await git("git", ["add", "."], { cwd: root });
    await git("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-qm", "fixture"], { cwd: root });
    return readWorkspaceHead(root);
  }
  const base = await commit();
  await writeTree(root, {
    "official/index.html": "<h1>Official</h1>",
    "official/dist/index.html": "<h1>Official</h1>",
    "landing/dist/index.html": "<h1>Landing</h1>",
  });
  const head = await commit();
  return { root, base, head, commit };
}

test("one affected frontend publishes and reads back only its bound deployment", async () => {
  const { root, base, head, commit } = await staticFixture();
  const home = await mkdtemp(join(tmpdir(), "workspace-static-home-"));
  roots.push(home);
  const plan = await ready(root, "production", ["official/index.html"]);
  expect(plan.applications.map(site => site.target)).toEqual([null, { project_ref: "sites", frontend_deployment_id: "official-web" }]);
  const client = fakeClient();
  const appExecution = await executeWorkspace({
    root, operation: "execute", environment: "production", changedFiles: ["official/index.html"],
    execute: true, planSha256: plan.plan_sha256, sourceRevision: head, headRevision: head, configDigest: "unused", client,
  });
  expect(appExecution.diagnostics[0]?.code).toBe("frontend-use-publish");
  expect(client.deploys).toEqual([]);

  const artifact = await createFrontendArchive(join(root, "official", "dist"));
  await artifact.cleanup();
  const prefix = "/v1/projects/sites";
  const frontend = `${prefix}/frontend/deployments`;
  const deployment = `${frontend}/official-web`;
  const receiptScope = { project_ref: "sites", deployment_id: "official-web" };
  const release = {
    ...receiptScope, schema: "supacloud.frontend-release.v2", release_id: artifact.sha256, sha256: artifact.sha256,
    tree_sha256: artifact.treeSha256, kind: "prebuilt_static", archive_format: "tar.zst",
    size_bytes: artifact.archiveBytes, file_count: 1, created_at: "2026-11-20T00:00:00.000Z",
  };
  const requests: string[] = [];
  let active: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      if (path.endsWith("/deployments/protocol")) return Response.json({
        protocol: "supacloud.project-deployment.v1", project_ref: "sites", environment_id: "production",
      });
      if (path === frontend) return Response.json([{ id: "landing-web" }, { id: "official-web" }]);
      if (path === `${deployment}/active-release`) return Response.json({
        ...receiptScope, active_release_id: active ? release.release_id : null, active_activation_id: active,
        releases: active ? [release] : [], next_cursor: null,
      });
      if (request.method === "POST" && path === `${deployment}/releases`) {
        const digest = createHash("sha256").update(Buffer.from(await request.arrayBuffer())).digest("hex");
        if (digest !== release.release_id) return new Response(null, { status: 400 });
        return Response.json({ ...receiptScope, release }, { status: 201 });
      }
      if (request.method === "POST" && path === `${deployment}/releases/${release.release_id}/activate`) {
        const body = await request.json() as Record<string, unknown>;
        if (body.expected_active_release_id !== "absent" || body.expected_activation_id !== "absent"
          || typeof body.mutation_id !== "string") return new Response(null, { status: 400 });
        active = body.mutation_id;
        return Response.json({
          ...receiptScope, active_release_id: release.release_id, activation_id: active, release,
          mutation: { mutation_id: active, status: "succeeded", replayed: false },
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const entry = fileURLToPath(new URL("../../index.ts", import.meta.url));
  async function publish({ execute = true, confirm = true, site = "official", hash = plan.plan_sha256, project = "sites",
    profile = "production", readOnly = false, revision = head }: {
    execute?: boolean; confirm?: boolean; site?: string; hash?: string; project?: string; profile?: string; readOnly?: boolean; revision?: string;
  } = {}) {
    const subprocess = Bun.spawn([process.execPath, entry, "workspace", "publish",
      "--environment", "production", "--base", base, "--source-revision", revision,
      "--plan-sha256", hash, "--application", site, "--skip-build", "--format", "json",
      ...(execute ? ["--execute"] : []),
      ...(confirm ? ["--confirm-production", project] : []),
    ], { cwd: root, env: {
      PATH: process.env.PATH, HOME: home, SUPACLOUD_ENV: profile, SUPACLOUD_API_URL: server.url.origin,
      SUPACLOUD_API_TOKEN: "fixture", SUPACLOUD_PROJECT_REF: project, SUPACLOUD_READ_ONLY: String(readOnly),
    }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([
      subprocess.exited, new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(),
    ]);
    return { exit, stdout, stderr };
  }
  try {
    for (const [input, message] of [
      [{ execute: false }, /Pass --execute/],
      [{ confirm: false }, /confirm-production/],
      [{ readOnly: true }, /read-only/],
      [{ site: "landing" }, /not an affected static frontend/],
      [{ profile: "staging" }, /match the active Management API profile/],
      [{ project: "other" }, /project ref does not match/],
      [{ hash: "a".repeat(64) }, /plan digest does not match/],
      [{ revision: "b".repeat(40) }, /source-revision to match HEAD/],
    ] as const) {
      const result = await publish(input);
      expect(result.exit).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(message);
    }
    expect(requests).toEqual([]);
    const result = await publish();
    expect(result.exit, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ...receiptScope, active_release_id: release.release_id });
    expect(requests).toEqual([
      `GET ${prefix}/environments/production/deployments/protocol`,
      `GET ${frontend}`,
      `GET ${deployment}/active-release`,
      `POST ${deployment}/releases`,
      `POST ${deployment}/releases/${release.release_id}/activate`,
      `GET ${deployment}/active-release`,
    ]);

    requests.length = 0;
    await writeFile(join(root, "official", "supacloud.json"), JSON.stringify({ frontend: { id: "landing-web" } }));
    const dirty = await publish();
    expect(dirty.exit).toBe(1);
    expect(`${dirty.stdout}\n${dirty.stderr}`).toContain("requires a clean workspace");
    const revision = await commit();
    const mismatched = await ready(root, "production", ["official/index.html", "official/supacloud.json"]);
    const wrongId = await publish({ revision, hash: mismatched.plan_sha256 });
    expect(wrongId.exit).toBe(1);
    expect(`${wrongId.stdout}\n${wrongId.stderr}`).toContain("frontend.id does not match");
    expect(requests).toEqual([]);

    await writeTree(root, {
      "official/supacloud.json": JSON.stringify({ frontend: { outputDirectory: "dist/link/nested" } }),
      "landing/dist/nested/index.html": "<h1>Landing</h1>",
    });
    await symlink(join(root, "landing", "dist"), join(root, "official", "dist", "link"), "dir");
    const linkedRevision = await commit();
    const linkedPlan = await ready(root, "production", ["official/index.html", "official/supacloud.json"]);
    const wrongOutput = await publish({ revision: linkedRevision, hash: linkedPlan.plan_sha256 });
    expect(wrongOutput.exit).toBe(1);
    expect(`${wrongOutput.stdout}\n${wrongOutput.stderr}`).toContain("output directory must stay inside");
    expect(requests).toEqual([`GET ${prefix}/environments/production/deployments/protocol`, `GET ${frontend}`]);
  } finally {
    server.stop(true);
  }
});

test("static bindings cannot alias the same frontend across environments", async () => {
  const { root } = await staticFixture();
  const [official, landing] = staticWorkspace.applications;
  await writeFile(join(root, "supacloud.workspace.json"), JSON.stringify({
    ...staticWorkspace,
    applications: [official, { ...landing, environments: {
      ...landing!.environments, staging: official!.environments.production,
    } }],
  }));
  const plan = await ready(root, "production", ["official/index.html"]);
  expect(plan.status).toBe("blocked");
  expect(plan.diagnostics[0]?.code).toBe("ambiguous-frontend-target");
  expect(plan.applications.every(site => !site.target)).toBe(true);
});

test("an application change builds and deploys only that staging project", async () => {
  const { root, digest } = await fixture(["apps/storefront/src/page.ts"]);
  const plan = await ready(root, "staging", ["apps/storefront/src/page.ts"]);
  const client = fakeClient();
  const result = await executeWorkspace({ root, operation: "execute", environment: "staging", changedFiles: ["apps/storefront/src/page.ts"], execute: true, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  expect(result.status).toBe("accepted");
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
  const storefront = executed.targets.find(target => target.application_id === "storefront")!;
  client.seed("stor-stg", "storefront", { releaseId: "f".repeat(64), manifestSha256: "e".repeat(64) });
  const promoted = await executeWorkspace({
    root, operation: "promote", environment: "production", changedFiles: changed, execute: true,
    planSha256: production.plan_sha256, sourceRevision: revision, headRevision: revision, approvalId: "a".repeat(64),
    configurationId: "11234567-89ab-4def-8123-456789abcdef", sourceEnvironment: "staging", releaseId: storefront.release_id!,
    applicationId: "storefront", configDigest: digest, client,
  });
  expect(client.builds).toEqual(["admin", "storefront"]);
  expect(client.transfers).toEqual([`${storefront.release_id}:stor-prd/storefront`]);
  expect(promoted.status).toBe("accepted");
  expect(promoted.builds).toEqual([]);
  expect(promoted.targets.every(target => target.reused_build)).toBe(true);
  client.promoteStatus = "failed";
  const failed = await executeWorkspace({
    root, operation: "promote", environment: "production", changedFiles: changed, execute: true,
    planSha256: production.plan_sha256, sourceRevision: revision, headRevision: revision, approvalId: "a".repeat(64),
    configurationId: "11234567-89ab-4def-8123-456789abcdef", sourceEnvironment: "staging",
    releaseId: executed.targets.find(target => target.application_id === "admin")!.release_id!,
    applicationId: "admin", configDigest: digest, client,
  });
  expect(failed.status).toBe("failed");
});

test("a failed target retries the same mutation without another build and an unknown result is only reconciled", async () => {
  const changed = ["apps/worker/src/index.ts"];
  const { root, digest } = await fixture(changed);
  const plan = await ready(root, "staging", changed);
  const client = fakeClient();
  const first = await executeWorkspace({ root, operation: "execute", environment: "staging", changedFiles: changed, execute: true, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  const mutationId = first.targets[0]!.mutation_id!;
  client.fail("work-stg", "worker", mutationId, "failed");
  client.seed("work-stg", "worker", { releaseId: "9".repeat(64), manifestSha256: "8".repeat(64) });
  const retried = await executeWorkspace({ root, operation: "retry", environment: "staging", changedFiles: changed, execute: true, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, mutationId, configDigest: digest, client });
  expect(client.builds).toEqual(["worker"]);
  expect(retried.targets[0]?.mutation_id).toBe(mutationId);
  expect(retried.targets[0]?.release_id).toBe(first.targets[0]?.release_id);
  expect(retried.targets[0]?.release_id).not.toBe("9".repeat(64));
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
  expect(unapproved.diagnostics[0]?.code).toBe("approval-required");
  expect(unapproved.builds).toEqual([]);
  expect(client.builds).toEqual([]);
  expect(client.uploads).toEqual([]);
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

test("a forged source revision is compared with the checked-out commit and does not deploy", async () => {
  const changed = ["apps/storefront/src/page.ts"];
  const { root, digest } = await fixture(changed);
  await writeFile(join(root, "changed.txt"), `${changed[0]}\n`);
  await git("git", ["init", "-q"], { cwd: root });
  await git("git", ["add", "."], { cwd: root });
  await git("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "workspace"], { cwd: root });
  const head = await readWorkspaceHead(root);
  const plan = await ready(root, "staging", changed);
  const client = fakeClient();
  const forged = await runWorkspaceCommand({
    action: "execute", environment: "staging", root, changed: "changed.txt", execute: true,
    plan_sha256: plan.plan_sha256, source_revision: head === "b".repeat(40) ? "c".repeat(40) : "b".repeat(40),
  }, root, client);
  expect(forged.isError).toBe(true);
  expect(forged.content[0]?.text).toContain("source revision must match");
  expect(client.builds).toEqual([]);
  expect(client.uploads).toEqual([]);
  expect(client.deploys).toEqual([]);
  const matched = await runWorkspaceCommand({
    action: "execute", environment: "staging", root, changed: "changed.txt", execute: true,
    plan_sha256: plan.plan_sha256, source_revision: head,
  }, root, client);
  expect(digest).toHaveLength(64);
  expect(matched.isError).toBe(false);
  expect(client.builds).toEqual(["storefront"]);
});

test("a changed-file symlink and a credential repository are rejected without disclosing the secret", async () => {
  const { root } = await fixture(["apps/storefront/src/page.ts"]);
  const outside = await mkdtemp(join(tmpdir(), "workspace-secret-"));
  roots.push(outside);
  await writeFile(join(outside, "list.txt"), "embed-secret-path\n");
  await symlink(join(outside, "list.txt"), join(root, "changed.txt"));
  const client = fakeClient();
  const linked = await runWorkspaceCommand({ action: "execute", environment: "staging", root, changed: "changed.txt", execute: true, source_revision: revision }, root, client);
  expect(linked.isError).toBe(true);
  expect(linked.content[0]?.text ?? "").not.toContain("embed-secret");
  expect(client.builds).toEqual([]);
  const secret = "user:embed-secret@github.com/acme/store";
  await writeFile(join(root, "supacloud.workspace.json"), (await (await import("node:fs/promises")).readFile(join(root, "supacloud.workspace.json"), "utf8")).replace("github.com/acme/store", secret));
  const rejected = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["apps/storefront/src/page.ts"] });
  expect(rejected.status).toBe("blocked");
  expect(rejected.diagnostics[0]?.code).toBe("invalid-repository");
  expect(JSON.stringify(rejected)).not.toContain("embed-secret");
});

test("release inventory failure does not upload and reconcile keeps an unknown receipt unknown", async () => {
  const changed = ["apps/storefront/src/page.ts"];
  const { root, digest } = await fixture(changed);
  const plan = await ready(root, "staging", changed);
  const client = fakeClient();
  client.unavailable = true;
  const blocked = await executeWorkspace({ root, operation: "execute", environment: "staging", changedFiles: changed, execute: true, planSha256: plan.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client });
  expect(blocked.diagnostics[0]?.code).toBe("release-inventory-unavailable");
  expect(client.builds).toEqual([]);
  expect(client.uploads).toEqual([]);
  const calls: string[] = [];
  const http: WorkspaceHttp = {
    async get(path) {
      calls.push(`GET ${path}`);
      if (path.includes("/releases")) return { ok: false, status: 503, data: null };
      if (path.includes("/promotions/")) return { ok: false, status: 404, data: null };
      if (path.includes("/mutations/")) return { ok: true, status: 200, data: { status: "succeeded" } };
      if (path.includes("/history")) return { ok: true, status: 200, data: { history: [{ activation_id: "01234567-89ab-4def-8123-456789abcdef", release_id: "a".repeat(64) }] } };
      return { ok: false, status: 500, data: null };
    },
    async post(path) { calls.push(`POST ${path}`); return { ok: true, status: 200, data: { mutation: { status: "outcome_unknown" }, promotion: { release_id: "a".repeat(64) } } }; },
  };
  const remote = createHttpWorkspaceDeliveryClient(http, async () => { throw new Error("build must not run"); });
  expect((await remote.listReleases("stor-stg", "storefront")).availability).toBe("unavailable");
  const activation = await remote.readDeploy({ projectRef: "stor-stg", applicationId: "storefront", environmentId: "staging", mutationId: "01234567-89ab-4def-8123-456789abcdef", operation: "activation" });
  expect(activation).toMatchObject({ status: "succeeded", releaseId: "a".repeat(64) });
  expect(calls.some(call => call.includes("/promotions/"))).toBe(false);
  const reconciled = await remote.reconcilePromotion({ projectRef: "stor-prd", applicationId: "storefront", environmentId: "production", mutationId: "01234567-89ab-4def-8123-456789abcdef" });
  expect(reconciled.status).toBe("unknown");
  const deployed = await remote.deploy({
    projectRef: "stor-stg", applicationId: "storefront", environmentId: "staging", releaseId: "a".repeat(64),
    manifestSha256: "b".repeat(64), mutationId: "01234567-89ab-4def-8123-456789abcdef", approvalId: null,
    repository: "github.com/acme/store", configDigest: digest, sourceRevision: revision, workspacePlanSha256: plan.plan_sha256,
    configurationId: "11234567-89ab-4def-8123-456789abcdef", activationId: null, expectedActivationId: null,
  });
  expect(deployed.status).toBe("accepted");
  expect(calls.some(call => call.includes("/workspace-activations"))).toBe(true);
  expect(calls.some(call => call.includes("/environments/staging/activations"))).toBe(false);
});

test("blocked plans and explicitly unmatched applications never report a completed execution", async () => {
  const changed = ["apps/storefront/src/page.ts"];
  const { root, digest } = await fixture(changed);
  const blockedPlan = await createWorkspacePlan({ root, environment: "staging", changedFiles: ["README.md"] });
  const client = fakeClient();
  const blockedResult = await executeWorkspace({
    root, operation: "execute", environment: "staging", changedFiles: ["README.md"], execute: true,
    planSha256: blockedPlan.plan_sha256, sourceRevision: revision, headRevision: revision, configDigest: digest, client,
  });
  expect(blockedResult.status).toBe("blocked");
  expect(blockedResult.diagnostics[0]?.code).toBe("plan-not-ready");
  expect(client.builds).toEqual([]);

  const readyPlan = await createWorkspacePlan({ root, environment: "staging", changedFiles: changed });
  const unmatched = await executeWorkspace({
    root, operation: "execute", environment: "staging", changedFiles: changed, execute: true,
    planSha256: readyPlan.plan_sha256, sourceRevision: revision, headRevision: revision,
    applicationId: "admin", configDigest: digest, client,
  });
  expect(unmatched.status).toBe("blocked");
  expect(unmatched.diagnostics[0]?.code).toBe("application-not-affected");
  expect(client.builds).toEqual([]);
});
