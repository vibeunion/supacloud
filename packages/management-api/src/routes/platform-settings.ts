import { Elysia, t, status } from "elysia";
import { sql } from "../db";
import { logger } from "../utils/logger";
import { requireAdminAuth } from "../middleware/auth";

/**
 * Platform Settings Routes
 * 
 * Provides get/update operations for the platform_settings key-value table.
 * Used by the admin UI to dynamically configure AI API credentials, etc.
 */
export const platformSettingsRoutes = new Elysia({ name: "platform-settings" })

  // ─── GET /v1/platform/settings ─────────────────────────────────
  .get("/v1/platform/settings", async () => {
    try {
      const rows = await sql`SELECT key, value, description, is_secret, updated_at FROM platform_settings ORDER BY key`;
      // Mask secret values in the response
      const safe = (rows as Record<string, unknown>[]).map((r) => ({
        ...r,
        value: r.is_secret ? maskSecret(r.value as string) : r.value,
      }));
      return { data: safe };
    } catch (error: unknown) {
      logger.error("[PlatformSettings] Failed to read settings", { error });
      return { data: [], error: "Failed to read settings" };
    }
  })

  // ─── GET /v1/platform/settings/:key ────────────────────────────
  .get("/v1/platform/settings/:key", async ({ params }) => {
    try {
      const rows = await sql`SELECT key, value, description, is_secret, updated_at FROM platform_settings WHERE key = ${params.key}`;
      if (!rows.length) return { data: null };
      const row = rows[0] as Record<string, unknown>;
      return {
        data: {
          ...row,
          value: row.is_secret ? maskSecret(row.value as string) : row.value,
        },
      };
    } catch (error: unknown) {
      logger.error(`[PlatformSettings] Failed to read key=${params.key}`, { error });
      return { data: null, error: "Failed to read setting" };
    }
  })

  // ─── PUT /v1/platform/settings ─────────────────────────────────
  .put("/v1/platform/settings", async ({ body, request }) => {
    const authError = await requireAdminAuth(request);
    if (authError) return status(authError.status, authError.body);

    const items = body.items;

    if (items.length === 0) {
      return { success: false, error: "items array cannot be empty" };
    }

    try {
      for (const item of items) {
        await sql`
          INSERT INTO platform_settings (key, value, description, is_secret, updated_at)
          VALUES (${item.key}, ${item.value}, ${item.description ?? null}, ${item.is_secret ?? false}, NOW())
          ON CONFLICT (key) DO UPDATE
          SET value = EXCLUDED.value,
              description = COALESCE(EXCLUDED.description, platform_settings.description),
              is_secret = COALESCE(EXCLUDED.is_secret, platform_settings.is_secret),
              updated_at = NOW()
        `;
      }
      logger.info(`[PlatformSettings] Updated ${items.length} setting(s): ${items.map(i => i.key).join(", ")}`);
      return { success: true, updated: items.length };
    } catch (error: unknown) {
      logger.error("[PlatformSettings] Failed to update settings", { error });
      return { success: false, error: "Failed to update settings" };
    }
  }, {
    body: t.Object({
      items: t.Array(t.Object({
        key: t.String(),
        value: t.String(),
        description: t.Optional(t.String()),
        is_secret: t.Optional(t.Boolean())
      }))
    })
  });

/**
 * Mask a secret value for display, showing only the last 4 characters.
 */
function maskSecret(value: string): string {
  if (!value || value.length <= 6) return "••••••";
  return "••••••" + value.slice(-4);
}

/**
 * Internal helper: read a platform setting value by key (used by chat proxy etc).
 * Returns the raw value, NOT masked. Returns empty string if not found.
 */
export async function getPlatformSetting(key: string): Promise<string> {
  try {
    const rows = await sql`SELECT value FROM platform_settings WHERE key = ${key}`;
    if (rows.length === 0) return "";
    return (rows[0] as Record<string, unknown>).value as string;
  } catch {
    return "";
  }
}
