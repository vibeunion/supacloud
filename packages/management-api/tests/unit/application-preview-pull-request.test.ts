import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationReleaseId } from "@supacloud/delivery";
import { ApplicationPreviewService, type ApplicationPreviewServiceDependencies } from "../../src/services/application-preview.service";
import type { StoredApplicationPreview } from "../../src/services/application-preview-contract";
import { ApplicationPreviewConflictError } from "../../src/repositories/project-config-writes";
import {
  isolatePreviewFunctions, listPreviewFunctionSlugs, removePreviewFunctions,
} from "../../src/services/application-preview-isolation";
import { cleanupEmptyPreviewStorage, reclaimPreviewStorage } from "../../src/services/application-preview-cleanup";
import {
  applicationPreviewIdForPullRequest, applyPreviewPullRequest, previewReclaimLeftovers,
} from "../../src/services/application-preview-pull-request";
import { resolveBucketName } from "../../src/db";
import { runtimeInput } from "../helpers/application-runtime";

const configurationId = "91234567-89ab-4def-8123-456789abcdef";

interface Slot {
  database: boolean;
  queues: Set<string>;
  secrets: Set<string>;
  objects: string[];
  storage: boolean;
  functions: Set<string>;
  activation: string | null;
}

function slot(): Slot {
  return {
    database: false, queues: new Set(), secrets: new Set(), objects: [], storage: false,
    functions: new Set(), activation: null,
  };
}

test("pull request open provisions an isolated preview and close reclaims every resource", async () => {
  const projects = new Map<string, Slot>();
  const parent = slot();
  parent.database = true;
  parent.storage = true;
  parent.objects.push("parent-object");
  parent.functions.add("hello");
  parent.functions.add("worker");
  projects.set("demo", parent);
  const at = (ref: string) => {
    const current = projects.get(ref);
    if (!current) throw new Error(`missing ${ref}`);
    return current;
  };
  const ensure = (ref: string) => {
    const current = projects.get(ref) ?? slot();
    projects.set(ref, current);
    return current;
  };
  const configs: Record<string, unknown>[] = [{}];
  const calls: string[] = [];
  const record = runtimeInput().release;
  const releases = {
    readRelease: async (projectRef: string, applicationId: string, releaseId: string) => ({
      ...record, project_ref: projectRef, application_id: applicationId, release_id: releaseId,
      manifest_sha256: releaseId,
    }),
    materializeRelease: async (_projectRef: string, applicationId: string, releaseId: string, branchRef: string) => ({
      ...record, project_ref: branchRef, application_id: applicationId, manifest_sha256: releaseId,
      release_id: applicationReleaseId(branchRef, applicationId, releaseId),
    }),
  };
  const service = new ApplicationPreviewService({
    lifecycle: async (_projectRef, _previewId, operation) => operation(),
    branchLifecycle: async (_projectRef, operation) => operation(),
    releases,
    configurations: {
      read: async scope => ({
        schema: "supacloud.application-configuration.v1" as const, configuration_id: configurationId,
        project_ref: scope.projectRef, application_id: scope.applicationId, environment_id: scope.environmentId,
        created_at: "2026-10-10T00:00:00.000Z", bun_version: "1.4.3", targets: [],
      }),
      clone: async (_source, target, _sourceId, targetId) => ({
        schema: "supacloud.application-configuration.v1" as const, configuration_id: targetId ?? configurationId,
        project_ref: target.projectRef, application_id: target.applicationId, environment_id: target.environmentId,
        created_at: "2026-10-10T00:00:00.000Z", bun_version: "1.4.3", targets: [],
      }),
    },
    activate: async input => {
      ensure(input.branchRef).activation = input.activationId;
      calls.push("app:activate");
      return { activation_id: input.activationId };
    },
    projects: {
      findByRef: async () => ({ config: structuredClone(configs[0]), ref: "demo" } as never),
      saveApplicationPreview: async (_ref: string, input: StoredApplicationPreview, expected: string | null) => {
        const current = (configs[0]?.application_previews ?? []) as StoredApplicationPreview[];
        const index = current.findIndex(item => item.preview_id === input.preview_id);
        if (expected === null ? index >= 0 : current[index]?.updated_at !== expected) throw new ApplicationPreviewConflictError();
        const receipt = structuredClone(input);
        receipt.updated_at = new Date(Date.parse(expected ?? "2026-10-11T00:00:00.000Z") + 1).toISOString();
        configs[0] = {
          ...configs[0],
          application_previews: index < 0 ? [...current, receipt] : current.map((item, position) => position === index ? receipt : item),
        };
        return structuredClone(receipt);
      },
    },
    branches: {
      createBranch: async input => {
        calls.push("database:create");
        ensure(input.branchRef).database = true;
      },
      deleteBranch: async ref => {
        calls.push("database:delete");
        at(ref).database = false;
      },
    },
    queues: {
      createQueue: async (ref, name) => { calls.push("queue:create"); ensure(ref).queues.add(name); },
      dropQueue: async (ref, name) => { calls.push("queue:delete"); at(ref).queues.delete(name); return true; },
      listQueues: async ref => [...(projects.get(ref)?.queues ?? [])].map(queue_name => ({ queue_name }) as never),
    },
    secrets: {
      upsertSecrets: async (ref, values) => {
        calls.push("secret:create");
        for (const value of values) ensure(ref).secrets.add(value.name);
        return true;
      },
      deleteSecret: async (ref, name) => { calls.push("secret:delete"); return at(ref).secrets.delete(name); },
    },
    storage: {
      createBucket: async ref => { calls.push("storage:create"); ensure(ref).storage = true; return { success: true }; },
    },
    functions: {
      list: async ref => [...(projects.get(ref)?.functions ?? [])].sort(),
      isolate: async input => {
        calls.push("functions:isolate");
        const source = at(input.sourceRef);
        const target = ensure(input.targetRef);
        for (const slug of input.slugs) {
          if (!source.functions.has(slug)) throw new Error("APPLICATION_PREVIEW_FUNCTIONS_IDENTITY_MISMATCH");
          target.functions.add(slug);
        }
      },
      remove: async (ref, slugs) => {
        calls.push("functions:remove");
        const target = at(ref);
        for (const slug of slugs) target.functions.delete(slug);
      },
      listIsolated: async ref => [...(projects.get(ref)?.functions ?? [])].sort(),
    },
    invalidateEnv: async () => true,
    runtime: { checkStatus: async () => ({ status: "running", health: "healthy" } as never) },
    smokeTest: async () => ({ passed: ["application_readiness"], failed: [] }),
    cleanupChecks: {
      assertSafe: async () => {},
      deactivateApplication: async receipt => {
        calls.push("app:deactivate");
        at(receipt.resources.database_branch.branch_ref).activation = null;
      },
      reclaimStorage: async receipt => {
        calls.push("storage:reclaim");
        at(receipt.resources.database_branch.branch_ref).objects = [];
      },
      cleanupStorage: async receipt => {
        calls.push("storage:delete");
        const current = at(receipt.resources.database_branch.branch_ref);
        if (current.objects.length > 0) throw new Error("APPLICATION_PREVIEW_CLEANUP_STORAGE_OCCUPIED");
        current.storage = false;
      },
      verifySecretDeleted: async receipt => {
        if (at(receipt.resources.database_branch.branch_ref).secrets.has(receipt.test_secret_name)) {
          throw new Error("secret remains");
        }
      },
      verifyBranchDeleted: async receipt => {
        if (at(receipt.resources.database_branch.branch_ref).database) throw new Error("database remains");
      },
      databaseExists: async receipt => at(receipt.resources.database_branch.branch_ref).database,
    },
    reclaimAudit: async receipt => inspect(receipt),
  } satisfies ApplicationPreviewServiceDependencies);
  const inspect = async (receipt: StoredApplicationPreview) => {
    const current = at(receipt.resources.database_branch.branch_ref);
    return previewReclaimLeftovers({
      app: current.activation !== null,
      functions: [...current.functions],
      database: current.database,
      queue: current.queues.has(receipt.queue_name),
      storage: current.storage || current.objects.length > 0,
      secret: current.secrets.has(receipt.test_secret_name),
    });
  };
  const event = {
    repository: "acme/app", number: 7, projectRef: "demo", applicationId: "api",
    environmentId: "test", releaseId: "a".repeat(64),
  };
  const opened = await applyPreviewPullRequest(service, { ...event, action: "opened" }, inspect);
  expect(opened.status).toBe("ready");
  expect(opened.leftovers).toEqual([]);
  const branchRef = opened.receipt?.resources.database_branch.branch_ref;
  if (!branchRef) throw new Error("missing preview branch");
  const preview = at(branchRef);
  expect(preview.database).toBe(true);
  expect(preview.activation).toEqual(expect.any(String));
  expect([...preview.functions]).toEqual(["hello", "worker"]);
  expect(preview.queues.size).toBe(1);
  expect(preview.secrets.size).toBe(1);
  expect(preview.storage).toBe(true);
  expect(parent.functions).toEqual(new Set(["hello", "worker"]));
  const again = await applyPreviewPullRequest(service, { ...event, action: "opened" });
  expect(again.status).toBe("ready");
  expect(calls.filter(call => call === "database:create")).toHaveLength(1);
  preview.objects.push("preview-upload");
  const occupied = await service.cleanup("demo", opened.preview_id);
  expect(occupied?.status).not.toBe("cleaned");
  expect(occupied?.cleanup.error).toBe("APPLICATION_PREVIEW_CLEANUP_STORAGE_OCCUPIED");
  expect(preview.objects).toEqual(["preview-upload"]);
  expect(preview.database).toBe(true);
  const closed = await applyPreviewPullRequest(service, { ...event, action: "closed" }, inspect);
  expect(closed.status).toBe("cleaned");
  expect(closed.leftovers).toEqual([]);
  expect(preview).toMatchObject({
    database: false, storage: false, activation: null, objects: [],
  });
  expect(preview.functions.size).toBe(0);
  expect(preview.queues.size).toBe(0);
  expect(preview.secrets.size).toBe(0);
  expect(parent).toMatchObject({ database: true, storage: true, objects: ["parent-object"] });
  expect([...parent.functions]).toEqual(["hello", "worker"]);
  expect(calls.filter(call => call === "database:create")).toHaveLength(1);
  const repeated = await applyPreviewPullRequest(service, { ...event, action: "closed" }, inspect);
  expect(repeated.status).toBe("cleaned");
  expect(repeated.leftovers).toEqual([]);
  await expect(applyPreviewPullRequest(service, { ...event, action: "opened", releaseId: "b".repeat(64) }))
    .rejects.toThrow(ApplicationPreviewConflictError);
  expect(projects.size).toBe(2);
  const absent = await applyPreviewPullRequest(service, { ...event, number: 8, action: "closed" });
  expect(absent.status).toBe("absent");
  expect(applicationPreviewIdForPullRequest("acme/app", 7)).toBe(opened.preview_id);
  expect(applicationPreviewIdForPullRequest("acme/app", 8)).not.toBe(opened.preview_id);
});

test("preview function copies and storage reclaim leave the parent namespace untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-functions-"));
  const storage = await mkdtemp(join(tmpdir(), "preview-storage-"));
  const sourceRef = "demo";
  const targetRef = "pv0123456789ab4def81";
  const outside = join(storage, "keep");
  try {
    await mkdir(join(root, sourceRef, ".versions", "worker"), { recursive: true });
    await writeFile(join(root, sourceRef, "hello.js"), "export default hello");
    await writeFile(join(root, sourceRef, ".versions", "worker", "index.js"), "export default worker");
    await symlink(join(root, sourceRef, "hello.js"), join(root, sourceRef, "linked.js"));
    await isolatePreviewFunctions(root, sourceRef, targetRef, ["hello", "worker"]);
    expect(await listPreviewFunctionSlugs(root, targetRef)).toEqual(["hello", "worker"]);
    expect(await readFile(join(root, sourceRef, "hello.js"), "utf8")).toBe("export default hello");
    await expect(isolatePreviewFunctions(root, sourceRef, targetRef, ["linked"])).rejects.toThrow(
      "APPLICATION_PREVIEW_FUNCTIONS_UNSUPPORTED",
    );
    await removePreviewFunctions(root, targetRef, ["hello", "worker"]);
    expect(await listPreviewFunctionSlugs(root, targetRef)).toEqual([]);
    expect(await readFile(join(root, sourceRef, "hello.js"), "utf8")).toBe("export default hello");
    await writeFile(outside, "parent");
    const bucket = join(storage, resolveBucketName(targetRef));
    await mkdir(join(bucket, "nested"), { recursive: true });
    await writeFile(join(bucket, "nested", "object.txt"), "preview");
    await reclaimPreviewStorage(targetRef, storage);
    await expect(cleanupEmptyPreviewStorage(targetRef, storage)).resolves.toBeUndefined();
    expect(await readFile(outside, "utf8")).toBe("parent");
    await mkdir(bucket);
    await symlink(outside, join(bucket, "escape"));
    await expect(reclaimPreviewStorage(targetRef, storage)).rejects.toThrow(
      "APPLICATION_PREVIEW_CLEANUP_STORAGE_UNSUPPORTED",
    );
    expect(await readFile(outside, "utf8")).toBe("parent");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
});
