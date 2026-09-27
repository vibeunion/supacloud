export const STARTER_ATTACHMENT_SCHEMA = `-- Apply with the migration owner, never from an application process.
CREATE TABLE public.starter_attachments (
  review_id text PRIMARY KEY REFERENCES public.starter_reviews(id),
  artifact_id uuid NOT NULL UNIQUE, owner_id text NOT NULL, run_id uuid NOT NULL UNIQUE,
  object_path text NOT NULL UNIQUE
);
CREATE TABLE public.starter_attachment_results (
  review_id text NOT NULL REFERENCES public.starter_reviews(id),
  version integer NOT NULL CHECK (version >= 2), artifact_id uuid NOT NULL,
  result jsonb NOT NULL, PRIMARY KEY(review_id,version,artifact_id)
);
ALTER TABLE public.starter_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.starter_attachment_results ENABLE ROW LEVEL SECURITY;
`;

export const STARTER_ATTACHMENT_POSTGRES = `import { SupaCloudArtifactsClient } from "@supacloud/js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommandDatabase, CommandTransaction } from "@supacloud/db";
import type { ReviewAttachmentInput, ReviewAttachmentResult, ReviewAttachmentStore } from "../review/attachment";

export interface ReviewAttachmentOptions {
  database: CommandDatabase;
  // Provision this client for the same project as the database; never use a caller's bearer token.
  service: SupabaseClient;
  projectId: string;
  tenantId: string;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid attachment database result");
  return value.map(record);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Invalid attachment record");
  return value;
}
function durableResult(value: unknown): ReviewAttachmentResult {
  const item = record(value);
  if (typeof item.reviewId !== "string" || typeof item.artifactId !== "string"
    || typeof item.version !== "number" || typeof item.sha256 !== "string"
    || typeof item.bytes !== "number" || Object.keys(item).length !== 5) {
    throw new Error("Invalid durable attachment result");
  }
  return { reviewId: item.reviewId, artifactId: item.artifactId, version: item.version, sha256: item.sha256, bytes: item.bytes };
}

export async function createReviewAttachmentAdapters(options: ReviewAttachmentOptions): Promise<{
  store: ReviewAttachmentStore;
  enqueue(tx: CommandTransaction, reviewId: string, version: number): Promise<void>;
}> {
  const { database, service, projectId, tenantId } = options;
  if (!projectId.trim() || !tenantId.trim()) throw new TypeError("Attachment project/tenant is required");
  const artifacts = new SupaCloudArtifactsClient(service);
  const binding = rows(await database.transaction(tx => tx.query(
    "SELECT project_id,tenant_id FROM public.starter_application WHERE singleton",
  )));
  if (binding.length !== 1 || binding[0]?.project_id !== projectId || binding[0]?.tenant_id !== tenantId) {
    throw new Error("Attachment database project/tenant binding mismatch");
  }
  async function authorize(tx: CommandTransaction, input: ReviewAttachmentInput) {
    const allowed = rows(await tx.query(
      "SELECT a.object_path,a.run_id FROM public.starter_attachments a " +
      "JOIN public.starter_reviews r ON r.id=a.review_id AND r.owner_id=a.owner_id " +
      "JOIN public.starter_members m ON m.subject=a.owner_id AND m.enabled AND m.can_approve " +
      "CROSS JOIN public.starter_application p " +
      "WHERE a.review_id=$1 AND a.artifact_id=$2 AND r.version=$3 AND r.state='approved' " +
      "AND p.singleton AND p.project_id=$4 AND p.tenant_id=$5 " +
      "FOR UPDATE OF r,a,m FOR SHARE OF p",
      [input.reviewId, input.artifactId, input.version, projectId, tenantId],
    ));
    if (allowed.length !== 1 || typeof allowed[0]?.object_path !== "string") {
      throw new Error("Attachment worker authorization or review revision is no longer valid");
    }
    return allowed[0];
  }
  return {
    async enqueue(tx, reviewId, version) {
      const found = rows(await tx.query(
        "SELECT artifact_id FROM public.starter_attachments WHERE review_id=$1", [reviewId],
      ))[0];
      if (!found) return;
      const input = { reviewId, version, artifactId: String(found.artifact_id) };
      const allowed = await authorize(tx, input);
      // Bind serialized JSON as text so drivers cannot encode the string as a JSON scalar.
      await tx.query("SELECT supacloud_workflows.start_run($1::uuid,$2,'1','verify',$3::text::jsonb,3)", [
        String(allowed.run_id), "review.verify-attachment", JSON.stringify(input),
      ]);
    },
    store: {
      async readAttachment(input) {
        const allowed = await database.transaction(tx => authorize(tx, input));
        const artifact = await artifacts.get(input.artifactId);
        if (!artifact || artifact.bucketId !== "review-attachments"
          || artifact.objectPath !== allowed.object_path || artifact.artifactType !== "review.attachment"
          || artifact.mimeType !== "text/plain" || !/^[1-9][0-9]*$/.test(artifact.sizeBytes)
          || BigInt(artifact.sizeBytes) > 1048576n) throw new Error("Invalid attachment artifact");
        const downloaded = await service.storage.from(artifact.bucketId).download(artifact.objectPath);
        if (downloaded.error || !downloaded.data) throw new Error("Attachment download failed");
        if (downloaded.data.size !== Number(artifact.sizeBytes)) throw new Error("Attachment size mismatch");
        return { body: new Uint8Array(await downloaded.data.arrayBuffer()), sha256: artifact.sha256 };
      },
      async recordAttachment(input, result) {
        if (result.reviewId !== input.reviewId || result.version !== input.version
          || result.artifactId !== input.artifactId || !/^[a-f0-9]{64}$/.test(result.sha256)
          || !Number.isSafeInteger(result.bytes) || result.bytes < 1 || result.bytes > 1048576) {
          throw new Error("Invalid attachment result");
        }
        return database.transaction(async tx => {
          await authorize(tx, input);
          await tx.query(
            "INSERT INTO public.starter_attachment_results VALUES($1,$2,$3,$4::text::jsonb) ON CONFLICT DO NOTHING",
            [input.reviewId, input.version, input.artifactId, JSON.stringify(result)],
          );
          const saved = rows(await tx.query(
            "SELECT result FROM public.starter_attachment_results WHERE review_id=$1 AND version=$2 AND artifact_id=$3",
            [input.reviewId, input.version, input.artifactId],
          ))[0]?.result;
          const value = durableResult(saved);
          if (value.reviewId !== result.reviewId || value.version !== result.version || value.artifactId !== result.artifactId
            || value.sha256 !== result.sha256 || value.bytes !== result.bytes) {
            throw new Error("Conflicting durable attachment result");
          }
          return value;
        });
      },
    },
  };
}
`;
