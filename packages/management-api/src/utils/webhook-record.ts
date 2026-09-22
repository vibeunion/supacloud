import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const nullableText = Type.Union([Type.String(), Type.Null()]);
const webhookSchema = Type.Object({
  id: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" }),
  project_ref: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  events: Type.Array(Type.String({ pattern: "^(\\*|[A-Za-z0-9][A-Za-z0-9._:-]*)$", maxLength: 128 }), {
    minItems: 1, maxItems: 100, uniqueItems: true,
  }),
  secret_version: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  enabled: Type.Boolean(),
  api_version: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
  created_by: nullableText,
  created_at: Type.Date(),
  updated_at: Type.Date(),
  deleted_at: Type.Union([Type.Date(), Type.Null()]),
  has_secret: Type.Optional(Type.Boolean()),
});
export type WebhookRecord = Static<typeof webhookSchema>;

export class InvalidWebhookRecordError extends Error {
  constructor() {
    super("Invalid persisted webhook record");
    this.name = "InvalidWebhookRecordError";
  }
}

export function readWebhookRows(value: unknown, projectRef: string): WebhookRecord[] {
  if (!Array.isArray(value)) throw new InvalidWebhookRecordError();
  const ids = new Set<string>();
  return Array.from(value, (candidate: unknown) => {
    if (!Value.Check(webhookSchema, candidate)
      || candidate.project_ref !== projectRef || ids.has(candidate.id)) {
      throw new InvalidWebhookRecordError();
    }
    for (const event of candidate.events) {
      if (typeof event !== "string") throw new InvalidWebhookRecordError();
    }
    ids.add(candidate.id);
    // Only known public metadata crosses this boundary, never encrypted or future secret columns.
    return {
      id: candidate.id,
      project_ref: candidate.project_ref,
      url: candidate.url,
      events: [...candidate.events],
      secret_version: candidate.secret_version,
      enabled: candidate.enabled,
      api_version: candidate.api_version,
      created_by: candidate.created_by,
      created_at: new Date(candidate.created_at),
      updated_at: new Date(candidate.updated_at),
      deleted_at: candidate.deleted_at === null ? null : new Date(candidate.deleted_at),
      ...(candidate.has_secret === undefined ? {} : { has_secret: candidate.has_secret }),
    };
  });
}

export function readWebhookRow(value: unknown, projectRef: string, webhookId: string): WebhookRecord | null {
  const rows = readWebhookRows(value, projectRef);
  if (rows.length > 1) throw new InvalidWebhookRecordError();
  const row = rows[0];
  if (!row) return null;
  if (row.id !== webhookId.toLowerCase()) throw new InvalidWebhookRecordError();
  return row;
}

const countSchema = Type.Object({ count: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) });

export function readWebhookCount(value: unknown): number {
  if (!Array.isArray(value) || value.length !== 1) throw new InvalidWebhookRecordError();
  const row: unknown = value[0];
  if (!Value.Check(countSchema, row)) throw new InvalidWebhookRecordError();
  return row.count;
}
