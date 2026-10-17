import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrontendDeployment } from "../../src/types/frontend";
import {
  FRONTEND_RELEASE_SCHEMA,
  FRONTEND_ACTIVE_RELEASE_SCHEMA,
  type FrontendActiveReleaseRecord,
  type FrontendReleaseRecord,
} from "../../src/services/frontend-release-contract";
import { FrontendReleaseStorage } from "../../src/services/frontend-release-storage";

const PROJECT_REF = "abcdefghijklmnopqrst";
const DEPLOYMENT_ID = "fa-web";
const CREATED_AT = "2026-08-12T00:00:00.000Z";
const roots = new Set<string>();

function releaseId(index: number): string {
  return index.toString(16).padStart(64, "0");
}

class ObservedReleaseStorage extends FrontendReleaseStorage {
  reads = 0;
  peakConcurrentReads = 0;
  releaseIds: string[] = [];
  corruptReleaseId: string | null = null;
  private concurrentReads = 0;

  override async deployment(projectRef: string, deploymentId: string): Promise<FrontendDeployment> {
    return {
      id: deploymentId,
      project_ref: projectRef,
      name: "FA",
      framework: "static",
      domain: "fa.example.test",
      custom_domains: [],
      build_command: "",
      output_dir: ".",
      install_command: "",
      node_version: "20",
      env_vars: {},
      status: "success",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      deployment_url: "https://fa.example.test",
    };
  }

  override async releaseRecord(
    projectRef: string,
    deploymentId: string,
    id: string,
  ): Promise<FrontendReleaseRecord> {
    this.releaseIds.push(id);
    if (id === this.corruptReleaseId) throw new Error("Release integrity verification failed");
    this.concurrentReads += 1;
    this.peakConcurrentReads = Math.max(this.peakConcurrentReads, this.concurrentReads);
    try {
      await Bun.sleep(1);
      this.reads += 1;
      return {
        schema: FRONTEND_RELEASE_SCHEMA,
        project_ref: projectRef,
        deployment_id: deploymentId,
        release_id: id,
        sha256: id,
        tree_sha256: id,
        size_bytes: 1,
        file_count: 1,
        created_at: CREATED_AT,
        archive_format: "tar.zst" as const, kind: "prebuilt_static",
      };
    } finally {
      this.concurrentReads -= 1;
    }
  }

}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

test("validates a maximum release page with one full integrity read at a time", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontend-release-list-"));
  roots.add(root);
  const releasesDir = join(root, PROJECT_REF, DEPLOYMENT_ID, "releases");
  await mkdir(releasesDir, { recursive: true });
  for (let index = 0; index < 100; index += 1) {
    await mkdir(join(releasesDir, releaseId(index)));
  }
  const storage = new ObservedReleaseStorage({ baseDir: root });

  const inventory = await storage.listReleases(PROJECT_REF, DEPLOYMENT_ID, { limit: 100 });

  expect(inventory.releases).toHaveLength(100);
  expect(storage.reads).toBe(100);
  expect(storage.peakConcurrentReads).toBe(1);
});

test("the active snapshot verifies only its artifact even with corrupt historical releases", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontend-active-snapshot-"));
  roots.add(root);
  const directory = join(root, PROJECT_REF, DEPLOYMENT_ID);
  for (let index = 0; index < 100; index += 1) {
    await mkdir(join(directory, "releases", releaseId(index)), { recursive: true });
  }
  const active: FrontendActiveReleaseRecord = {
    schema: FRONTEND_ACTIVE_RELEASE_SCHEMA,
    project_ref: PROJECT_REF, deployment_id: DEPLOYMENT_ID,
    release_id: releaseId(1), sha256: releaseId(1), tree_sha256: releaseId(1),
    activation_id: "11111111-1111-4111-8111-111111111111",
    mutation_id: "11111111-1111-4111-8111-111111111111",
    activated_at: CREATED_AT,
  };
  await writeFile(join(directory, "active-release.json"), JSON.stringify(active));
  const storage = new ObservedReleaseStorage({ baseDir: root });
  storage.corruptReleaseId = releaseId(99);
  const snapshot = await storage.activeReleaseSnapshot(PROJECT_REF, DEPLOYMENT_ID);
  expect(snapshot.active_release_id).toBe(active.release_id);
  expect(snapshot.active_activation_id).toBe(active.activation_id);
  expect(snapshot.releases).toHaveLength(1);
  expect(snapshot.next_cursor).toBeNull();
  expect(storage.releaseIds).toEqual([active.release_id, active.release_id]);
  storage.corruptReleaseId = active.release_id;
  await expect(storage.activeReleaseSnapshot(PROJECT_REF, DEPLOYMENT_ID))
    .rejects.toThrow("integrity verification failed");
});

test("an absent active authority returns an empty snapshot without inspecting history", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontend-active-absent-"));
  roots.add(root);
  const storage = new ObservedReleaseStorage({ baseDir: root });
  expect(await storage.activeReleaseSnapshot(PROJECT_REF, DEPLOYMENT_ID)).toEqual({
    project_ref: PROJECT_REF, deployment_id: DEPLOYMENT_ID,
    active_release_id: null, active_activation_id: null, releases: [], next_cursor: null,
  });
  expect(storage.reads).toBe(0);
});
