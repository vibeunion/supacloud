import { t } from "elysia";

export const V1ProjectResponseSchema = t.Object({
  id: t.String(),
  ref: t.String(),
  organization_id: t.String(),
  organization_slug: t.String(),
  name: t.String(),
  region: t.String(),
  created_at: t.String(),
  status: t.String(),
});

export const V1ProjectWithDatabaseResponseSchema = t.Intersect([
  V1ProjectResponseSchema,
  t.Object({
    database: t.Object({
      host: t.String(),
      version: t.String(),
      postgres_engine: t.String(),
      release_channel: t.String(),
    })
  })
]);
