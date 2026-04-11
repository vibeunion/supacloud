/**
 * SSO/SAML Provider Management API
 * 
 * P0-3: CRUD for auth.sso_providers, auth.sso_domains, auth.saml_providers
 * Required by Studio Auth > SSO page and supabase.auth.signInWithSSO()
 */
import { Elysia, t, status } from "elysia";
import { projectService } from "../services";
import { getProjectDb } from "../db";
import { sql as metaSql } from "../db";
import { logger } from "../utils/logger";

export const authSsoRoutes = new Elysia({ prefix: "/v1/projects" })

  // List all SSO providers
  .get(
    "/:ref/auth/sso/providers",
    async ({ params }) => {
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);
        const providers = await db`
          SELECT sp.id, sp.resource_id, sp.created_at, sp.updated_at,
            (SELECT json_agg(json_build_object('id', sd.id, 'domain', sd.domain))
             FROM auth.sso_domains sd WHERE sd.sso_provider_id = sp.id) as domains,
            (SELECT json_agg(json_build_object('id', smp.id, 'entity_id', smp.entity_id, 'metadata_url', smp.metadata_url, 'attribute_mapping', smp.attribute_mapping))
             FROM auth.saml_providers smp WHERE smp.sso_provider_id = sp.id) as saml
          FROM auth.sso_providers sp
          ORDER BY sp.created_at DESC
        `;
        return providers;
      } catch (err) {
        logger.warn("[auth-sso] Failed to list SSO providers — table may not exist yet", { error: err });
        return [];
      }
    },
    { params: t.Object({ ref: t.String() }) }
  )

  // Create SSO provider
  .post(
    "/:ref/auth/sso/providers",
    async ({ params, body }) => {
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);
        const providerId = crypto.randomUUID();

        await db`
          INSERT INTO auth.sso_providers (id, resource_id, created_at, updated_at)
          VALUES (${providerId}, ${body.resource_id || null}, now(), now())
        `;

        // Create associated domains
        if (body.domains && Array.isArray(body.domains)) {
          for (const domain of body.domains) {
            await db`
              INSERT INTO auth.sso_domains (id, sso_provider_id, domain, created_at, updated_at)
              VALUES (${crypto.randomUUID()}, ${providerId}, ${domain}, now(), now())
            `;
          }
        }

        // Create SAML provider entry
        if (body.metadata_xml) {
          await db`
            INSERT INTO auth.saml_providers (id, sso_provider_id, entity_id, metadata_xml, metadata_url, attribute_mapping, created_at, updated_at)
            VALUES (${crypto.randomUUID()}, ${providerId}, ${body.entity_id || providerId}, ${body.metadata_xml}, ${body.metadata_url || null}, ${body.attribute_mapping ? JSON.stringify(body.attribute_mapping) : null}::jsonb, now(), now())
          `;
        }

        return { id: providerId, resource_id: body.resource_id || null };
      } catch (err: unknown) {
        return status(500, { error: "Failed to create SSO provider", message: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      params: t.Object({ ref: t.String() }),
      body: t.Object({
        resource_id: t.Optional(t.String()),
        domains: t.Optional(t.Array(t.String())),
        metadata_xml: t.Optional(t.String()),
        metadata_url: t.Optional(t.String()),
        entity_id: t.Optional(t.String()),
        attribute_mapping: t.Optional(t.Record(t.String(), t.Unknown())),
      })
    }
  )

  // Get specific SSO provider
  .get(
    "/:ref/auth/sso/providers/:id",
    async ({ params }) => {
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);
        const [provider] = await db`
          SELECT sp.id, sp.resource_id, sp.created_at, sp.updated_at,
            (SELECT json_agg(json_build_object('id', sd.id, 'domain', sd.domain))
             FROM auth.sso_domains sd WHERE sd.sso_provider_id = sp.id) as domains,
            (SELECT json_agg(json_build_object('id', smp.id, 'entity_id', smp.entity_id, 'metadata_url', smp.metadata_url))
             FROM auth.saml_providers smp WHERE smp.sso_provider_id = sp.id) as saml
          FROM auth.sso_providers sp
          WHERE sp.id = ${params.id}::uuid
        `;
        if (!provider) return status(404, { error: "SSO provider not found" });
        return provider;
      } catch (err: unknown) {
        return status(500, { error: "Failed to get SSO provider", message: err instanceof Error ? err.message : String(err) });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }) }
  )

  // Update SSO provider
  .put(
    "/:ref/auth/sso/providers/:id",
    async ({ params, body }) => {
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);

        if (body.resource_id !== undefined) {
          await db`UPDATE auth.sso_providers SET resource_id = ${body.resource_id}, updated_at = now() WHERE id = ${params.id}::uuid`;
        }

        // Replace domains if provided
        if (body.domains && Array.isArray(body.domains)) {
          await db`DELETE FROM auth.sso_domains WHERE sso_provider_id = ${params.id}::uuid`;
          for (const domain of body.domains) {
            await db`
              INSERT INTO auth.sso_domains (id, sso_provider_id, domain, created_at, updated_at)
              VALUES (${crypto.randomUUID()}, ${params.id}::uuid, ${domain}, now(), now())
            `;
          }
        }

        // Update SAML metadata if provided
        if (body.metadata_xml) {
          await db`
            UPDATE auth.saml_providers 
            SET metadata_xml = ${body.metadata_xml}, 
                metadata_url = ${body.metadata_url || null},
                attribute_mapping = ${body.attribute_mapping ? JSON.stringify(body.attribute_mapping) : null}::jsonb,
                updated_at = now()
            WHERE sso_provider_id = ${params.id}::uuid
          `;
        }

        return { id: params.id, updated: true };
      } catch (err: unknown) {
        return status(500, { error: "Failed to update SSO provider", message: err instanceof Error ? err.message : String(err) });
      }
    },
    {
      params: t.Object({ ref: t.String(), id: t.String() }),
      body: t.Object({
        resource_id: t.Optional(t.String()),
        domains: t.Optional(t.Array(t.String())),
        metadata_xml: t.Optional(t.String()),
        metadata_url: t.Optional(t.String()),
        attribute_mapping: t.Optional(t.Record(t.String(), t.Unknown())),
      })
    }
  )

  // Delete SSO provider (cascades to domains + SAML)
  .delete(
    "/:ref/auth/sso/providers/:id",
    async ({ params }) => {
      const [project] = await metaSql`SELECT db_name FROM projects WHERE ref=${params.ref}`;
      if (!project) return status(404, { error: "Project not found" });

      try {
        const db = getProjectDb(project.db_name);
        await db`DELETE FROM auth.sso_providers WHERE id = ${params.id}::uuid`;
        return { success: true };
      } catch (err: unknown) {
        return status(500, { error: "Failed to delete SSO provider", message: err instanceof Error ? err.message : String(err) });
      }
    },
    { params: t.Object({ ref: t.String(), id: t.String() }) }
  );
