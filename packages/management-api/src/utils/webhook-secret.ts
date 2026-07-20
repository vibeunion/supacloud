export const WEBHOOK_SIGNING_SECRET_PREFIX = "webhook-";

export function webhookSigningSecretName(webhookId: string): string {
  return `${WEBHOOK_SIGNING_SECRET_PREFIX}${webhookId}`;
}
