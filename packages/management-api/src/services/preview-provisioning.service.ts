import {
  composePreviewEnvironment,
  previewsDueForReclamation,
  type PreviewComponentName,
  type PreviewComposeInput,
  type PreviewEnvironment,
  type PreviewEnvironmentIsolationCheck,
  type PreviewIsolationCheckKey,
  type PreviewReclaimCandidate,
} from "./preview-environment.service";

/** Minimal branch port surface, satisfied by the existing `branchService`. */
export interface PreviewBranchPort {
  createBranch(input: { parentRef: string; branchRef: string; name: string; dataMode?: "schema_only" | "full_clone" }): Promise<void>;
  deleteBranch(branchRef: string): Promise<void>;
}

/** Adapt the existing database branch service to the preview database port. */
export function createPreviewDatabasePort(branches: PreviewBranchPort): Pick<PreviewProvisioningPorts, "database"> {
  return {
    database: {
      create: (preview) => branches.createBranch({
        parentRef: preview.project_ref,
        branchRef: preview.branch_ref,
        name: preview.branch_ref,
        dataMode: preview.data_mode,
      }),
      delete: (preview) => branches.deleteBranch(preview.branch_ref),
    },
  };
}

/** Minimal queue port surface, satisfied by `pgmqService`. */
export interface PreviewQueuePort {
  createQueue(projectRef: string, queue: string): Promise<unknown>;
  dropQueue(projectRef: string, queue: string): Promise<unknown>;
}

/** Minimal bucket port surface, satisfied by a storage driver. */
export interface PreviewBucketPort {
  createBucket(projectRef: string, bucket: string): Promise<unknown>;
  deleteBucket(projectRef: string, bucket: string): Promise<unknown>;
}

/** Deterministic, lowercase, bounded preview queue/bucket names. */
export function previewQueueName(preview: PreviewEnvironment, queue: string): string {
  return `preview_${preview.preview_ref}__${queue}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 63);
}
export function previewBucketName(preview: PreviewEnvironment, bucket: string): string {
  return `${preview.branch_ref}-${bucket}`.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 63);
}

/** Adapt the project queue service to the preview queue port. */
export function createPreviewQueuePort(pgmq: PreviewQueuePort): Pick<PreviewProvisioningPorts, "queues"> {
  return {
    queues: {
      create: async (preview) => {
        for (const queue of preview.queue_names) await pgmq.createQueue(preview.project_ref, previewQueueName(preview, queue));
      },
      delete: async (preview) => {
        for (const queue of preview.queue_names) await pgmq.dropQueue(preview.project_ref, previewQueueName(preview, queue));
      },
    },
  };
}

/** Adapt a project storage driver to the preview storage port. */
export function createPreviewStoragePort(storage: PreviewBucketPort): Pick<PreviewProvisioningPorts, "storage"> {
  return {
    storage: {
      create: async (preview) => {
        for (const bucket of preview.storage_buckets) await storage.createBucket(preview.project_ref, previewBucketName(preview, bucket));
      },
      delete: async (preview) => {
        for (const bucket of preview.storage_buckets) await storage.deleteBucket(preview.project_ref, previewBucketName(preview, bucket));
      },
    },
  };
}

/**
 * Ports a preview provisioner must supply. The orchestration below is pure: it
 * never connects anywhere itself, and every side effect goes through a port so
 * a caller can wire real infrastructure (or a fake in tests) and so a failure
 * is attributable to one component.
 */
export interface PreviewProvisioningPorts {
  database: { create(preview: PreviewEnvironment): Promise<void>; delete(preview: PreviewEnvironment): Promise<void> };
  application: { activate(preview: PreviewEnvironment): Promise<void> };
  configuration: { bind(preview: PreviewEnvironment): Promise<void> };
  resources: { bind(preview: PreviewEnvironment): Promise<void> };
  queues: { create(preview: PreviewEnvironment): Promise<void>; delete(preview: PreviewEnvironment): Promise<void> };
  storage: { create(preview: PreviewEnvironment): Promise<void>; delete(preview: PreviewEnvironment): Promise<void> };
  secrets: { bind(preview: PreviewEnvironment): Promise<void> };
  isolation: { verify(check: PreviewIsolationCheckKey, preview: PreviewEnvironment): Promise<boolean> };
}

export type PreviewRunStatus = "ready" | "failed";

export interface PreviewProvisionResult {
  preview: PreviewEnvironment;
  status: PreviewRunStatus;
  failed_component?: PreviewComponentName;
  error?: string;
}

export interface PreviewReclamationResult {
  preview_ref: string;
  released: PreviewComponentName[];
  failed: Array<{ component: PreviewComponentName; error: string }>;
}

export interface StoredPreviewEnvironment {
  preview: PreviewEnvironment;
  created_at: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setComponent(
  preview: PreviewEnvironment,
  name: PreviewComponentName,
  status: "planned" | "ready" | "failed",
): PreviewEnvironment {
  return {
    ...preview,
    components: preview.components.map((component) => component.name === name ? { ...component, status } : component),
  };
}

/**
 * Provision a complete preview environment in dependency order. It fails closed:
 * the first failing port stops provisioning and is recorded on that component;
 * isolation checks only run once every component is ready. The returned preview
 * is `ready` only when all four isolation checks verify.
 */
export async function provisionPreviewEnvironment(
  ports: PreviewProvisioningPorts,
  input: PreviewComposeInput,
): Promise<PreviewProvisionResult> {
  let preview = composePreviewEnvironment(input);
  const steps: Array<[PreviewComponentName, (current: PreviewEnvironment) => Promise<void>]> = [
    ["database", (current) => ports.database.create(current)],
    ["application", (current) => ports.application.activate(current)],
    ["configuration", (current) => ports.configuration.bind(current)],
    ["resources", (current) => ports.resources.bind(current)],
    ["queues", (current) => ports.queues.create(current)],
    ["storage", (current) => ports.storage.create(current)],
    ["secrets", (current) => ports.secrets.bind(current)],
  ];
  for (const [name, run] of steps) {
    try {
      await run(preview);
      preview = setComponent(preview, name, "ready");
    } catch (error) {
      preview = setComponent(preview, name, "failed");
      return { preview, status: "failed", failed_component: name, error: messageOf(error) };
    }
  }

  const isolation: PreviewEnvironmentIsolationCheck[] = [];
  for (const check of preview.isolation) {
    let verified = false;
    try {
      verified = await ports.isolation.verify(check.key, preview);
    } catch {
      verified = false;
    }
    isolation.push({ ...check, status: verified ? "verified" : "failed" });
  }
  preview = { ...preview, isolation };
  return { preview, status: isolation.every((check) => check.status === "verified") ? "ready" : "failed" };
}

/**
 * Release the namespace-scoped components and then the database branch. It keeps
 * going after a failure so a partially reclaimed preview does not keep its
 * residue, and reports exactly which releases failed.
 */
export async function reclaimPreviewEnvironment(
  ports: Pick<PreviewProvisioningPorts, "database" | "queues" | "storage">,
  preview: PreviewEnvironment,
): Promise<PreviewReclamationResult> {
  const steps: Array<[PreviewComponentName, () => Promise<void>]> = [
    ["storage", () => ports.storage.delete(preview)],
    ["queues", () => ports.queues.delete(preview)],
    ["database", () => ports.database.delete(preview)],
  ];
  const released: PreviewComponentName[] = [];
  const failed: PreviewReclamationResult["failed"] = [];
  for (const [name, run] of steps) {
    try {
      await run();
      released.push(name);
    } catch (error) {
      failed.push({ component: name, error: messageOf(error) });
    }
  }
  return { preview_ref: preview.preview_ref, released, failed };
}

/** Reclaim only the previews whose timeout has elapsed, leaving `pr_closed` previews to their webhook. */
export async function reclaimDuePreviews(
  ports: Pick<PreviewProvisioningPorts, "database" | "queues" | "storage">,
  previews: ReadonlyArray<StoredPreviewEnvironment>,
  now: Date,
): Promise<PreviewReclamationResult[]> {
  const candidates: PreviewReclaimCandidate[] = previews.map(({ preview, created_at }) => ({
    preview_ref: preview.preview_ref, created_at, lifecycle: preview.lifecycle,
  }));
  const due = new Set(previewsDueForReclamation(candidates, now).map((candidate) => candidate.preview_ref));
  const results: PreviewReclamationResult[] = [];
  for (const stored of previews) {
    if (!due.has(stored.preview.preview_ref)) continue;
    results.push(await reclaimPreviewEnvironment(ports, stored.preview));
  }
  return results;
}