import { Elysia, status, t } from "elysia";
import { requireAdminAuth } from "../middleware/auth";
import { platformSettingsService } from "../services/platform-settings.service";

async function requirePlatformAdmin(request: Request) {
  const authError = await requireAdminAuth(request);
  return authError ? status(authError.status, authError.body) : null;
}

export const platformSettingsRoutes = new Elysia({ name: "platform-settings" })
  .get("/v1/platform/settings", async ({ request }) => {
    const authError = await requirePlatformAdmin(request);
    if (authError) return authError;
    const data = await platformSettingsService.list();
    return { data };
  }, {
    detail: { tags: ["projects"], summary: "List all platform settings" },
  })
  .get("/v1/platform/settings/:key", async ({ params, request }) => {
    const authError = await requirePlatformAdmin(request);
    if (authError) return authError;
    return { data: await platformSettingsService.getSafe(params.key) };
  }, {
    detail: { tags: ["projects"], summary: "Get a platform setting by key" },
  })
  .put("/v1/platform/settings", async ({ body, request }) => {
    const authError = await requirePlatformAdmin(request);
    if (authError) return authError;
    if (body.items.length === 0) {
      return status(400, { code: "INVALID_SETTINGS", message: "items array cannot be empty" });
    }
    const updated = await platformSettingsService.update(body.items);
    return { success: true, updated };
  }, {
    body: t.Object({
      items: t.Array(t.Object({
        key: t.String({ minLength: 1, maxLength: 255 }),
        value: t.String({ maxLength: 24576 }),
        description: t.Optional(t.String({ maxLength: 1024 })),
        is_secret: t.Optional(t.Boolean()),
      })),
    }),
    detail: { tags: ["projects"], summary: "Bulk update platform settings" },
  });
