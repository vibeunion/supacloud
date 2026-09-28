export const STARTER_UPLOAD_FEATURE = `import { Body, Controller, Inject, Injectable, Param, Post, DB_CLIENT, REQUEST_CONTEXT } from "@supacloud/app";
import { ApplicationError } from "@supacloud/elysia";
import { t } from "elysia";

export interface ReviewUploadInput { reviewId: string; artifactId: string; expectedVersion: number }
export interface ReviewUploadLocation { artifactId: string; bucketId: string; objectPath: string }
export interface ReviewUploadResult { artifactId: string; runId: string; objectPath: string; sha256: string; bytes: number }
export interface ReviewUploadPort {
  previewUpload(context: unknown, input: ReviewUploadInput): Promise<ReviewUploadLocation>;
  registerUpload(context: unknown, input: ReviewUploadInput): Promise<ReviewUploadResult>;
}
export const UploadParams = t.Object({ id: t.String({ format: "uuid" }) });
export const UploadBody = t.Object({
  artifactId: t.String({ format: "uuid" }), expectedVersion: t.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export const UploadLocation = t.Object({
  artifactId: t.String({ format: "uuid" }), bucketId: t.String(), objectPath: t.String(),
});
export const UploadResult = t.Object({
  artifactId: t.String({ format: "uuid" }), runId: t.String({ format: "uuid" }),
  objectPath: t.String(), sha256: t.String({ pattern: "^[a-f0-9]{64}$" }), bytes: t.Integer({ minimum: 1, maximum: 1048576 }),
});

@Injectable({ scope: "request" })
export class ReviewUploads {
  constructor(@Inject(DB_CLIENT) private readonly store: Partial<ReviewUploadPort>,
    @Inject(REQUEST_CONTEXT) private readonly context: unknown) {}

  preview(input: ReviewUploadInput): Promise<ReviewUploadLocation> {
    if (!this.store.previewUpload) throw new ApplicationError("Attachment uploads are not configured", { status: 501, code: "UPLOADS_UNAVAILABLE" });
    return this.store.previewUpload(this.context, input);
  }
  register(input: ReviewUploadInput): Promise<ReviewUploadResult> {
    if (!this.store.registerUpload) throw new ApplicationError("Attachment uploads are not configured", { status: 501, code: "UPLOADS_UNAVAILABLE" });
    return this.store.registerUpload(this.context, input);
  }
}

@Controller("/reviews")
export class ReviewUploadsController {
  constructor(@Inject(ReviewUploads) private readonly uploads: ReviewUploads) {}

  @Post("/:id/attachment-upload", { params: UploadParams, body: UploadBody, responses: { 200: UploadLocation } })
  preview(@Param("id") id: string, @Body() body: { artifactId: string; expectedVersion: number }): Promise<ReviewUploadLocation> {
    return this.uploads.preview({ reviewId: id, artifactId: body.artifactId, expectedVersion: body.expectedVersion });
  }
  @Post("/:id/attachment-registration", { params: UploadParams, body: UploadBody, responses: { 200: UploadResult } })
  register(@Param("id") id: string, @Body() body: { artifactId: string; expectedVersion: number }): Promise<ReviewUploadResult> {
    return this.uploads.register({ reviewId: id, artifactId: body.artifactId, expectedVersion: body.expectedVersion });
  }
}
`;

export const STARTER_UPLOAD_SCHEMA = `-- Apply explicitly with the migration owner.
ALTER TABLE public.starter_members ADD COLUMN storage_subject uuid UNIQUE;
GRANT SELECT (subject,enabled,can_approve,storage_subject) ON public.starter_members TO authenticated;
CREATE POLICY starter_member_read ON public.starter_members FOR SELECT TO authenticated
  USING (subject=COALESCE(NULLIF(auth.jwt()->>'external_sub',''),auth.jwt()->>'sub') AND storage_subject=auth.uid());
GRANT SELECT ON public.starter_reviews TO authenticated;
CREATE POLICY starter_review_read ON public.starter_reviews FOR SELECT TO authenticated
  USING (owner_id=COALESCE(NULLIF(auth.jwt()->>'external_sub',''),auth.jwt()->>'sub') AND EXISTS (
    SELECT 1 FROM public.starter_members m WHERE m.subject=owner_id
      AND m.enabled AND m.can_approve AND m.storage_subject=auth.uid()
  ));
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  VALUES ('review-attachments','review-attachments',false,1048576,ARRAY['text/plain']);
CREATE POLICY starter_attachment_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='review-attachments');
CREATE POLICY starter_attachment_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id='review-attachments');
-- Restrictive fences also apply when the host already has permissive Storage policies.
CREATE POLICY starter_attachment_owner_fence ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated
  USING (bucket_id<>'review-attachments' OR (split_part(name,'/',1)=auth.uid()::text AND EXISTS (
    SELECT 1 FROM public.starter_reviews r JOIN public.starter_members m ON m.subject=r.owner_id
    WHERE r.id=split_part(name,'/',2) AND m.subject=COALESCE(NULLIF(auth.jwt()->>'external_sub',''),auth.jwt()->>'sub')
      AND m.storage_subject=auth.uid() AND m.enabled AND m.can_approve
  )))
  WITH CHECK (bucket_id<>'review-attachments' OR (split_part(name,'/',1)=auth.uid()::text
    AND name ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}/[a-f0-9-]{36}[.]txt$' AND EXISTS (
      SELECT 1 FROM public.starter_reviews r JOIN public.starter_members m ON m.subject=r.owner_id
      WHERE r.id=split_part(name,'/',2) AND r.state='draft' AND m.subject=COALESCE(NULLIF(auth.jwt()->>'external_sub',''),auth.jwt()->>'sub')
        AND m.storage_subject=auth.uid() AND m.enabled AND m.can_approve
    )));
CREATE POLICY starter_attachment_update_fence ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (bucket_id<>'review-attachments') WITH CHECK (bucket_id<>'review-attachments');
CREATE POLICY starter_attachment_delete_fence ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (bucket_id<>'review-attachments');
`;

export const STARTER_UPLOAD_ADAPTER = `import { MIMEType } from "node:util";
import { SupaCloudArtifactsClient } from "@supacloud/js";
import { createTransactionalCommand, plaintextCommandInput } from "@supacloud/commands";
import { CommandError } from "@supacloud/contracts";
import { createPostgresCommandStore, type CommandTransaction } from "@supacloud/db";
import { ApplicationError, requireTrustedIdentity } from "@supacloud/elysia";
import type { ReviewAttachmentOptions } from "./review-attachments";
import type { ReviewUploadInput, ReviewUploadPort, ReviewUploadResult } from "../review/uploads";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("Invalid upload record");
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid upload database result");
  return value.map(record);
}
function capture(value: unknown): ReviewUploadInput {
  const item = record(value), uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof item.reviewId !== "string" || !uuid.test(item.reviewId)
    || typeof item.artifactId !== "string" || !uuid.test(item.artifactId)
    || typeof item.expectedVersion !== "number" || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 1) {
    throw new ApplicationError("Invalid upload input", { status: 400, code: "UPLOAD_INPUT_INVALID" });
  }
  return { reviewId: item.reviewId.toLowerCase(), artifactId: item.artifactId.toLowerCase(), expectedVersion: item.expectedVersion };
}
function result(value: unknown): ReviewUploadResult {
  const item = record(value);
  if (typeof item.artifactId !== "string" || typeof item.runId !== "string" || typeof item.objectPath !== "string"
    || typeof item.sha256 !== "string" || typeof item.bytes !== "number") throw new TypeError("Invalid upload receipt");
  return { artifactId: item.artifactId, runId: item.runId, objectPath: item.objectPath, sha256: item.sha256, bytes: item.bytes };
}

export async function createReviewUploadAdapters(options: ReviewAttachmentOptions): Promise<ReviewUploadPort> {
  const { database, service, projectId, tenantId } = options;
  const binding = rows(await database.transaction(tx => tx.query(
    "SELECT project_id,tenant_id FROM public.starter_application WHERE singleton",
  )));
  if (!projectId.trim() || !tenantId.trim() || binding.length !== 1
    || binding[0]?.project_id !== projectId || binding[0]?.tenant_id !== tenantId) {
    throw new Error("Upload database project/tenant binding mismatch");
  }
  const artifacts = new SupaCloudArtifactsClient(service);
  function actor(context: unknown): string {
    const who = requireTrustedIdentity(context);
    const access = record(record(context).access);
    if (access.projectId !== projectId || access.tenantId !== tenantId
      || !Array.isArray(access.permissions) || !access.permissions.includes("review.approve")) {
      throw new ApplicationError("Upload permission denied", { status: 403, code: "UPLOAD_DENIED" });
    }
    return who.subject;
  }
  async function authorize(tx: CommandTransaction, subject: string, input: ReviewUploadInput, replay = false) {
    const allowed = rows(await tx.query(
      "SELECT m.storage_subject::text AS storage_subject FROM public.starter_reviews r " +
      "JOIN public.starter_members m ON m.subject=r.owner_id CROSS JOIN public.starter_application p " +
      "WHERE r.id=$1 AND r.owner_id=$2 AND ((r.state='draft' AND r.version=$3) OR " +
      "($6::boolean AND r.state='approved' AND r.version=$3+1 AND EXISTS (" +
      "SELECT 1 FROM public.starter_attachments b WHERE b.review_id=r.id AND b.artifact_id=$7::uuid AND b.owner_id=$2 " +
      "AND b.object_path=m.storage_subject::text || '/' || r.id || '/' || $7::text || '.txt'))) " +
      "AND m.enabled AND m.can_approve AND m.storage_subject IS NOT NULL " +
      "AND p.singleton AND p.project_id=$4 AND p.tenant_id=$5 FOR UPDATE OF r,m FOR SHARE OF p",
      [input.reviewId, subject, input.expectedVersion, projectId, tenantId, replay, input.artifactId],
    ));
    if (allowed.length !== 1 || typeof allowed[0]?.storage_subject !== "string") {
      throw new ApplicationError("Upload ownership, permission or revision changed", { status: 403, code: "UPLOAD_DENIED" });
    }
    return allowed[0].storage_subject + "/" + input.reviewId + "/" + input.artifactId + ".txt";
  }
  return {
    async previewUpload(context, value) {
      const input = capture(value), subject = actor(context);
      const objectPath = await database.transaction(tx => authorize(tx, subject, input));
      return { artifactId: input.artifactId, bucketId: "review-attachments", objectPath };
    },
    async registerUpload(context, value) {
      const input = capture(value), subject = actor(context);
      const objectPath = await database.transaction(tx => authorize(tx, subject, input, true));
      try {
        const downloaded = await service.storage.from("review-attachments").download(objectPath);
        if (downloaded.error || !downloaded.data) throw new Error("Upload unavailable");
        const blob = downloaded.data;
        if (blob.size < 1 || blob.size > 1048576 || new MIMEType(blob.type).essence !== "text/plain") {
          throw new ApplicationError("Unsupported upload", { status: 400, code: "UPLOAD_CONTENT_INVALID" });
        }
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())),
          byte => byte.toString(16).padStart(2, "0")).join("");
        await artifacts.register({ artifactId: input.artifactId, bucketId: "review-attachments", objectPath,
          artifactType: "review.attachment", sha256, sizeBytes: blob.size, mimeType: "text/plain" });
        const command = createTransactionalCommand({
          name: "review.attach", store: createPostgresCommandStore(database), inputCodec: plaintextCommandInput,
          input: capture, result,
          async authorize(who, request, tx) {
            try {
              const currentPath = await authorize(tx, who.actorId, request, true);
              return currentPath === objectPath ? "allow" : "deny";
            } catch (error) {
              if (error instanceof ApplicationError && error.code === "UPLOAD_DENIED") return "deny";
              throw error;
            }
          },
          async execute(tx, request) {
            const existing = rows(await tx.query("SELECT artifact_id FROM public.starter_attachments WHERE review_id=$1", [request.reviewId]));
            if (existing.length) throw new CommandError("COMMAND_IDEMPOTENCY_CONFLICT");
            const bound: ReviewUploadResult = { artifactId: request.artifactId, runId: request.artifactId, objectPath, sha256, bytes: blob.size };
            await tx.query("INSERT INTO public.starter_attachments VALUES($1,$2,$3,$4,$5)",
              [request.reviewId, bound.artifactId, subject, bound.runId, bound.objectPath]);
            return bound;
          },
          audit: { event: "review.attachment-bound", details: request => ({ reviewId: request.reviewId, artifactId: request.artifactId }) },
        });
        const receipt = await command.execute({ actorId: subject, tenantId }, input.artifactId, input);
        if (receipt.status !== "confirmed") throw new CommandError("COMMAND_OUTCOME_UNKNOWN");
        return receipt.result;
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        if (error instanceof CommandError && error.code === "COMMAND_IDEMPOTENCY_CONFLICT") {
          throw new ApplicationError("Conflicting attachment binding", { status: 409, code: error.code });
        }
        if (error instanceof CommandError && error.code === "COMMAND_REJECTED") {
          throw new ApplicationError("Upload permission denied", { status: 403, code: error.code });
        }
        // Registration may have committed even when binding failed; never delete immutable evidence here.
        throw new ApplicationError("Upload registration could not be confirmed", { status: 503, code: "UPLOAD_OUTCOME_UNKNOWN" });
      }
    },
  };
}
`;
