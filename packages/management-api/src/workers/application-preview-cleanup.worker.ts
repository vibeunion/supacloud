import { sql } from "../db";
import type { ApplicationPreviewService } from "../services/application-preview.service";
import { logger } from "../utils/logger";

const INTERVAL_MS = 60_000;
const BATCH_SIZE = 16;
export interface PreviewCleanupCursor { projectRef: string; previewId: string }
export interface PreviewCleanupCandidate { projectRef: string; preview: unknown }
export interface PreviewCleanupSweep {
  checked: number;
  attempted: number;
  cleaned: number;
  pending: number;
  skipped: number;
  cursor: PreviewCleanupCursor | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export async function discoverPreviewCleanupCandidates(
  cursor: PreviewCleanupCursor | null, limit: number,
): Promise<PreviewCleanupCandidate[]> {
  const rows = await sql<{ ref: string; preview: unknown }[]>`
    SELECT projects.ref, entry.preview
    FROM projects
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(config->'application_previews') = 'array'
        THEN config->'application_previews' ELSE '[]'::jsonb END
    ) AS entry(preview)
    WHERE projects.deleted_at IS NULL
      AND entry.preview->>'preview_id' IS NOT NULL
      AND entry.preview->>'expires_at' IS NOT NULL
      AND entry.preview->>'status' <> 'cleaned'
      AND (${cursor === null} OR projects.ref > ${cursor?.projectRef ?? ""}
        OR (projects.ref = ${cursor?.projectRef ?? ""} AND entry.preview->>'preview_id' > ${cursor?.previewId ?? ""}))
    ORDER BY projects.ref, entry.preview->>'preview_id'
    LIMIT ${limit}
  `;
  return rows.map(row => ({ projectRef: row.ref, preview: row.preview }));
}

export async function runApplicationPreviewCleanupSweep(input: {
  previews: Pick<ApplicationPreviewService, "cleanup">;
  discover?: typeof discoverPreviewCleanupCandidates;
  cursor?: PreviewCleanupCursor | null;
  now?: number;
}): Promise<PreviewCleanupSweep> {
  const rows = await (input.discover ?? discoverPreviewCleanupCandidates)(input.cursor ?? null, BATCH_SIZE);
  const now = input.now ?? Date.now();
  const result: PreviewCleanupSweep = {
    checked: rows.length, attempted: 0, cleaned: 0, pending: 0, skipped: 0, cursor: null,
  };
  for (const { projectRef, preview } of rows) {
    const id = object(preview) ? preview["preview_id"] : undefined;
    if (typeof id === "string") result.cursor = { projectRef, previewId: id };
    const expiresAt = object(preview) ? preview["expires_at"] : undefined;
    const createdAt = object(preview) ? preview["created_at"] : undefined;
    if (!object(preview) || !/^[a-z0-9-]{1,20}$/.test(projectRef)
      || typeof id !== "string" || !/^[a-f0-9-]{8,64}$/.test(id)
      || preview["schema"] !== "supacloud.application-preview.v1"
      || preview["project_ref"] !== projectRef
      || !["provisioning", "ready", "failed"].includes(String(preview["status"]))
      || !object(preview["cleanup"]) || preview["cleanup"]["required"] !== true
      || preview["cleanup"]["completed"] !== false
      || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))
      || new Date(expiresAt).toISOString() !== expiresAt
      || typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))
      || Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(expiresAt) > now) {
      result.skipped++;
      continue;
    }
    result.attempted++;
    try {
      const receipt = await input.previews.cleanup(projectRef, id, { automatic: true });
      if (receipt?.project_ref === projectRef && receipt.preview_id === id
        && receipt.status === "cleaned" && receipt.cleanup.completed && !receipt.cleanup.required) {
        result.cleaned++;
      } else {
        result.pending++;
      }
    } catch {
      // Provider failures can carry credentials. Keep the durable receipt and
      // report only counters; another project in this batch must still run.
      result.pending++;
    }
  }
  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<void> | null = null;
let cursor: PreviewCleanupCursor | null = null;

export function startApplicationPreviewCleanupWorker(previews: Pick<ApplicationPreviewService, "cleanup">): void {
  if (timer) return;
  const sweep = () => {
    if (running) return;
    const operation = runApplicationPreviewCleanupSweep({ previews, cursor }).then(result => {
      cursor = result.cursor;
      if (result.attempted) logger.info("[ApplicationPreviewCleanup] sweep completed", {
        attempted: result.attempted, cleaned: result.cleaned, pending: result.pending,
      });
    }).catch(() => logger.error("[ApplicationPreviewCleanup] discovery failed"))
      .finally(() => { if (running === operation) running = null; });
    running = operation;
  };
  timer = setInterval(sweep, INTERVAL_MS);
  sweep();
}

export async function stopApplicationPreviewCleanupWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await running;
  cursor = null;
}
