import { sql } from "../db";

const REPLAY_TTL_SECONDS = 300;
const WEBHOOK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export async function consumeAuthHookWebhookId(projectRef: string, webhookId: string): Promise<boolean> {
  if (!WEBHOOK_ID_PATTERN.test(webhookId)) return false;
  const replayKey = `auth-hook:${projectRef}:${webhookId}`;
  if (replayKey.length > 128) return false;
  const expiresAt = new Date(Date.now() + REPLAY_TTL_SECONDS * 1000);
  return sql.begin(async (transaction) => {
    await transaction`
      DELETE FROM supaoauth_bff_proof_nonces
      WHERE expires_at <= NOW()
    `;
    const inserted = await transaction`
      INSERT INTO supaoauth_bff_proof_nonces (nonce, expires_at)
      VALUES (${replayKey}, ${expiresAt})
      ON CONFLICT (nonce) DO NOTHING
      RETURNING nonce
    `;
    return inserted.length === 1;
  });
}
