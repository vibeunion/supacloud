import { t } from "elysia";
import { createSchemaDecoder } from "../../schema_contract";

export const WebhookInputSchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 200 }), enabled: t.Boolean(),
}, { additionalProperties: false });
export const decodeWebhookInput = createSchemaDecoder(WebhookInputSchema);
export const WebhookReceiptSchema = t.Object({
  tenantId: t.String(), actorId: t.String(), command: t.Literal("webhook.update.v1"),
  operationId: t.String(), dispatchKey: t.String(),
  status: t.Literal("confirmed"), audit: t.Literal("complete"), result: WebhookInputSchema,
}, { additionalProperties: false });
export const WebhookKeySchema = t.Object({ key: t.String({ minLength: 1, maxLength: 200 }) });
export const WebhookLookupSchema = t.Object({
  receipt: t.Union([WebhookReceiptSchema, t.Null()]),
}, { additionalProperties: false });
