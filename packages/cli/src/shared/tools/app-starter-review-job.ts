export const STARTER_REVIEW_JOB = `import { DB_CLIENT, Inject, Injectable, Job } from "@supacloud/app";
import { ApplicationError } from "@supacloud/elysia";
import { t } from "elysia";
import type { Static } from "elysia/type";

export const AttachmentInput = t.Object({
  reviewId: t.String({ minLength: 1, maxLength: 100 }),
  version: t.Integer({ minimum: 2 }),
  artifactId: t.String({ format: "uuid" }),
}, { additionalProperties: false });

export const AttachmentResult = t.Object({
  ...AttachmentInput.properties,
  sha256: t.String({ pattern: "^[a-f0-9]{64}$" }),
  bytes: t.Integer({ minimum: 1, maximum: 1048576 }),
}, { additionalProperties: false });

export type ReviewAttachmentInput = Static<typeof AttachmentInput>;
export type ReviewAttachmentResult = Static<typeof AttachmentResult>;

export interface ReviewAttachmentStore {
  // Resolve the immutable artifact under the worker's own authorization and current review revision.
  readAttachment(input: ReviewAttachmentInput): Promise<{ body: Uint8Array; sha256: string }>;
  // Revalidate revision/ownership and persist idempotently in a transaction; return the durable result.
  recordAttachment(input: ReviewAttachmentInput, result: ReviewAttachmentResult): Promise<ReviewAttachmentResult>;
}

@Injectable({ scope: "job" })
@Job({
  name: "review.verify-attachment", mode: "task", idempotency: "required",
  timeoutSec: 30, maxAttempts: 3, input: AttachmentInput, output: AttachmentResult,
})
export class VerifyReviewAttachment {
  constructor(@Inject(DB_CLIENT) private readonly store: ReviewAttachmentStore) {}

  async run(input: ReviewAttachmentInput): Promise<ReviewAttachmentResult> {
    const source = await this.store.readAttachment(input);
    if (source.body.byteLength < 1 || source.body.byteLength > 1048576) {
      throw new ApplicationError("Attachment size is outside the supported range", { code: "ATTACHMENT_SIZE_INVALID" });
    }
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(source.body));
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    if (sha256 !== source.sha256) {
      throw new ApplicationError("Attachment integrity check failed", { code: "ATTACHMENT_INTEGRITY_FAILED" });
    }
    return this.store.recordAttachment(input, { ...input, sha256, bytes: source.body.byteLength });
  }
}
`;

export const STARTER_REVIEW_JOB_TEST = `import { expect, test } from "bun:test";
import { VerifyReviewAttachment, type ReviewAttachmentResult } from "../src/review/attachment";

const input = { reviewId: "review", version: 2, artifactId: "11111111-1111-4111-8111-111111111111" };
const body = new TextEncoder().encode("review attachment");
const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)),
  byte => byte.toString(16).padStart(2, "0")).join("");

test("attachment job awaits the authorized reader and the committed result", async () => {
  let recorded: ReviewAttachmentResult | undefined;
  const job = new VerifyReviewAttachment({
    async readAttachment() { return { body, sha256 }; },
    async recordAttachment(_input, result) { await Promise.resolve(); recorded = result; return result; },
  });
  expect(await job.run(input)).toEqual({ ...input, sha256, bytes: body.byteLength });
  expect(recorded).toEqual({ ...input, sha256, bytes: body.byteLength });
});

test("missing authorization, corrupted bytes and persistence failures are not successful jobs", async () => {
  let records = 0;
  for (const readAttachment of [
    async () => { throw new Error("Access denied"); },
    async () => ({ body, sha256: "0".repeat(64) }),
    async () => ({ body: new Uint8Array(), sha256 }),
    async () => ({ body: new Uint8Array(1048577), sha256 }),
  ]) {
    const job = new VerifyReviewAttachment({
      readAttachment, async recordAttachment(_input, result) { records++; return result; },
    });
    await expect(job.run(input)).rejects.toThrow();
  }
  expect(records).toBe(0);
  await expect(new VerifyReviewAttachment({
    async readAttachment() { return { body, sha256 }; },
    async recordAttachment() { throw new Error("Commit failed"); },
  }).run(input)).rejects.toThrow("Commit failed");
});
`;
