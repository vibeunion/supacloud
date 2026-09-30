import {
  PREVIEW_ENVIRONMENT_SCHEMA,
  previewsDueForReclamation,
  type PreviewEnvironment,
  type PreviewReclaimCandidate,
} from "./preview-environment.service";import {
  reclaimPreviewEnvironment,
  type PreviewReclamationPorts,
  type PreviewReclamationResult,
  type StoredPreviewEnvironment,
} from "./preview-provisioning.service";

/**
 * Minimal persistence surface for provisioned preview environments. It is a port
 * so the lifecycle driver can be tested without a database and so a caller can
 * back it with project config or a dedicated table.
 */
export interface PreviewStore {
  list(projectRef: string): Promise<StoredPreviewEnvironment[]>;
  save(projectRef: string, preview: StoredPreviewEnvironment): Promise<void>;
  remove(projectRef: string, previewRef: string): Promise<void>;
}

export interface PreviewLifecycleReport {
  checked: number;
  reclaimed: number;
  failed: Array<{ preview_ref: string; failed: PreviewReclamationResult["failed"] }>;
}

/** Persist a provisioned preview so the timeout worker can later read its age and lifecycle. */
export async function savePreview(
  store: PreviewStore,
  projectRef: string,
  preview: StoredPreviewEnvironment["preview"],
  now: Date,
): Promise<StoredPreviewEnvironment> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid preview timestamp");
  const stored: StoredPreviewEnvironment = { preview, created_at: now.toISOString() };
  await store.save(projectRef, stored);
  return stored;
}

/**
 * Mark a stored preview closed without reclaiming yet. The next reclamation
 * pass picks it up (zero grace), and the absolute deadline stays a backstop if
 * the close event is ever missed.
 */
export async function markPreviewClosed(
  store: PreviewStore,
  projectRef: string,
  previewRef: string,
  now: Date,
): Promise<StoredPreviewEnvironment | null> {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid preview timestamp");
  const stored = await store.list(projectRef);
  const entry = stored.find((candidate) => candidate.preview.preview_ref === previewRef);
  if (!entry) return null;
  const closed: StoredPreviewEnvironment = { ...entry, closed_at: now.toISOString() };
  await store.save(projectRef, closed);
  return closed;
}

/**
 * Reclaim exactly the stored previews whose change closed or whose deadline
 * elapsed (first trigger wins). A preview is removed from the store only when
 * every release succeeds, so a failed reclamation keeps its record and residue
 * for the next pass.
 */
export async function reclaimStoredPreviews(
  store: PreviewStore,
  ports: PreviewReclamationPorts,
  projectRef: string,
  now: Date,
): Promise<PreviewLifecycleReport> {
  const stored = await store.list(projectRef);
  const candidates: PreviewReclaimCandidate[] = stored.map(({ preview, created_at, closed_at }) => ({
    preview_ref: preview.preview_ref, created_at, closed_at, lifecycle: preview.lifecycle,
  }));
  const due = new Set(previewsDueForReclamation(candidates, now).map((candidate) => candidate.preview_ref));
  const report: PreviewLifecycleReport = { checked: stored.length, reclaimed: 0, failed: [] };
  for (const entry of stored) {
    if (!due.has(entry.preview.preview_ref)) continue;
    const result = await reclaimPreviewEnvironment(ports, entry.preview);
    if (result.receipt.status === "reclaimed") {
      await store.remove(projectRef, entry.preview.preview_ref);
      report.reclaimed += 1;
    } else {
      report.failed.push({ preview_ref: entry.preview.preview_ref, failed: result.failed });
    }
  }
  return report;
}

/** Reclaim one preview by reference and remove its record only on full success. */
export async function closePreview(
  store: PreviewStore,
  ports: PreviewReclamationPorts,
  projectRef: string,
  previewRef: string,
): Promise<PreviewReclamationResult | null> {
  const stored = await store.list(projectRef);
  const entry = stored.find((candidate) => candidate.preview.preview_ref === previewRef);
  if (!entry) return null;
  const result = await reclaimPreviewEnvironment(ports, entry.preview);
  if (result.receipt.status === "reclaimed") await store.remove(projectRef, previewRef);
  return result;
}

export interface PreviewConfigPort {
  readConfig(projectRef: string): Promise<Record<string, unknown> | null>;
  writeConfig(projectRef: string, config: Record<string, unknown>): Promise<void>;
}

function isStoredPreview(value: unknown): value is StoredPreviewEnvironment {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const preview = row.preview as Record<string, unknown> | undefined;
  return typeof row.created_at === "string" && !!preview && !Array.isArray(preview)
    && typeof preview.preview_ref === "string" && preview.schema === PREVIEW_ENVIRONMENT_SCHEMA;
}

const PREVIEWS_KEY = "previews";

/**
 * Store previews inside the project config under a single `previews` collection.
 *
 * @deprecated Previews now live on the existing Supabase-compatible branch
 * records (`config.branches`) via `createBranchPreviewStore`, so the platform
 * keeps one branch model. Prefer that; this remains for stored `previews` data.
 */
export function createProjectConfigPreviewStore(port: PreviewConfigPort): PreviewStore {
  const read = async (projectRef: string): Promise<StoredPreviewEnvironment[]> => {
    const config = (await port.readConfig(projectRef)) ?? {};
    const raw = config[PREVIEWS_KEY];
    return Array.isArray(raw) ? raw.filter(isStoredPreview) : [];
  };
  return {
    list: read,
    async save(projectRef, preview) {
      const config = (await port.readConfig(projectRef)) ?? {};
      const existing = await read(projectRef);
      const next = existing.filter((entry) => entry.preview.preview_ref !== preview.preview.preview_ref);
      next.push(preview);
      await port.writeConfig(projectRef, { ...config, [PREVIEWS_KEY]: next });
    },
    async remove(projectRef, previewRef) {
      const config = (await port.readConfig(projectRef)) ?? {};
      const next = (await read(projectRef)).filter((entry) => entry.preview.preview_ref !== previewRef);
      await port.writeConfig(projectRef, { ...config, [PREVIEWS_KEY]: next });
    },
  };
}

/**
 * Store preview state on the existing Supabase-compatible branch records so the
 * platform has exactly one branch model. A preview's `preview_ref` **is** the
 * branch `ref`, so lifecycle operations update `config.branches` and never
 * delete the branch itself (branch deletion is owned by the branch routes).
 */
export function createBranchPreviewStore(port: PreviewConfigPort): PreviewStore {
  const branchesOf = (config: Record<string, unknown>): Record<string, unknown>[] => {
    const raw = config.branches;
    return Array.isArray(raw) ? raw.filter((branch): branch is Record<string, unknown> =>
      !!branch && typeof branch === "object" && !Array.isArray(branch)) : [];
  };
  const toStored = (branch: Record<string, unknown>): StoredPreviewEnvironment | null => {
    const envelope = branch.preview;
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null;
    const row = envelope as Record<string, unknown>;
    const environment = row.environment as Record<string, unknown> | undefined;
    if (!environment || environment.schema !== PREVIEW_ENVIRONMENT_SCHEMA
      || environment.preview_ref !== branch.ref || typeof row.created_at !== "string") return null;
    return {
      preview: environment as unknown as PreviewEnvironment,
      created_at: row.created_at,
      ...(typeof row.closed_at === "string" ? { closed_at: row.closed_at } : {}),
    };
  };
  return {
    async list(projectRef) {
      const config = (await port.readConfig(projectRef)) ?? {};
      return branchesOf(config).flatMap((branch) => {
        const stored = toStored(branch);
        return stored ? [stored] : [];
      });
    },
    async save(projectRef, stored) {
      const config = (await port.readConfig(projectRef)) ?? {};
      const branches = branchesOf(config);
      const envelope = {
        environment: stored.preview,
        created_at: stored.created_at,
        ...(stored.closed_at ? { closed_at: stored.closed_at } : {}),
      };
      const index = branches.findIndex((branch) => branch.ref === stored.preview.preview_ref);
      const next = index >= 0
        ? branches.map((branch, i) => i === index ? { ...branch, preview: envelope } : branch)
        : [...branches, {
          ref: stored.preview.preview_ref,
          parent_ref: stored.preview.project_ref,
          status: "active",
          created_at: stored.created_at,
          preview: envelope,
        }];
      await port.writeConfig(projectRef, { ...config, branches: next });
    },
    async remove(projectRef, previewRef) {
      const config = (await port.readConfig(projectRef)) ?? {};
      const next = branchesOf(config).map((branch) => {
        if (branch.ref !== previewRef) return branch;
        const { preview: _preview, ...rest } = branch;
        return rest;
      });
      await port.writeConfig(projectRef, { ...config, branches: next });
    },
  };
}