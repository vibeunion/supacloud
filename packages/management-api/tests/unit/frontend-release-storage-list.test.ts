import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FrontendDeployment } from "../../src/types/frontend";
import {
  FRONTEND_RELEASE_SCHEMA,
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
        kind: "prebuilt_static",
      };
    } finally {
      this.concurrentReads -= 1;
    }
  }

  override async activeRelease(): Promise<null> {
    return null;
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
