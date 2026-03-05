import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { logger } from "../utils/logger";
import { db, getProjectDb, dbConfig } from "../db";
import { pgMetaManager } from "../db/pg-meta";

/**
 * 核心助手：处理项目引用。
 * 解决 Studio 随机 ID 问题。
 */
const getProjectOrThrow = async (ref: string) => {
    // 强制匹配：如果 ref 看起来像 Studio 随机生成的 10 位字符标识符，或者是 "default"，或者找不到该项目，则回退到第一个项目
    const isRandomRef = /^[a-z0-9]{10}$/.test(ref) || ref === "default";
    try {
        let project: any = null;
        if (!isRandomRef) {
            project = await projectService.getProject(ref);
        }
        if (!project) {
            const projects = await projectService.listProjects();
            project = projects[0];
        }
        if (!project) throw new Error("No projects found");
        return project;
    } catch (e) {
        const projects = await projectService.listProjects();
        if (projects[0]) return projects[0];
        throw new Error("Project not found");
    }
};

const formatProject = (project: any) => ({
    id: project.id,
    ref: project.ref,
    name: project.name,
    status: "ACTIVE_HEALTHY",
    region: "local",
    organization_id: "esgfarm",
    cloud_provider: "localhost",
    inserted_at: project.created_at,
    updated_at: project.updated_at || null,
    // 关键服务：告知 Studio 启用哪些功能卡片
    services: [
        { name: "database", status: "ACTIVE_HEALTHY" },
        { name: "auth", status: "ACTIVE_HEALTHY" },
        { name: "storage", status: "ACTIVE_HEALTHY" },
        { name: "functions", status: "ACTIVE_HEALTHY" },
        { name: "realtime", status: "ACTIVE_HEALTHY" }
    ],
    // 数据库连接配置
    db_host: "localhost",
    db_name: project.database?.name || `supa_${project.ref}`,
    db_port: 5432,
    db_user: "postgres",
    db_pass: "postgres",
    db_ssl: false,
});

/**
 * 统一导出所有 Studio 兼容路由。
 * 注意：所有路径都包含在 /api 前缀下（在 index.ts 中挂载）。
 * 这里的路径从 /platform 或 /v1 开始。
 */
export const studioRoutes = new Elysia()
    // --- Auth & Profile ---
    .get("/auth/session", () => ({ user: { id: "1", email: "admin@supacloud.local" } }))
    .get("/auth/user", () => ({ id: "1", email: "admin@supacloud.local" }))
    .get("/platform/auth/user", () => ({ id: "1", email: "admin@supacloud.local", aud: "authenticated", role: "authenticated" }))
    .get("/platform/profile", async () => {
        const projects = await projectService.listProjects();
        return {
            id: 1, primary_email: "admin@supacloud.local",
            organizations: [{ id: "esgfarm", name: "esgfarm", slug: "esgfarm", projects: projects.map(formatProject) }]
        };
    })
    .get("/platform/config", () => ({ platform_name: "SupaCloud", features: { analytics: true, storage: true, functions: true } }))

    // --- Organizations ---
    .get("/v1/organizations", () => [{ id: "esgfarm", name: "esgfarm", slug: "esgfarm" }])
    .get("/platform/organizations", () => [{ id: "esgfarm", name: "esgfarm", slug: "esgfarm" }])
    .get("/platform/organizations/:slug", () => ({ id: "esgfarm", name: "esgfarm", slug: "esgfarm", plan: "pro" }))

    // --- Projects (v1) ---
    .get("/v1/projects", async () => {
        const projects = await projectService.listProjects();
        return projects.map(p => ({ id: p.id, ref: p.ref, name: p.name, organization_id: "esgfarm" }));
    })
    .get("/v1/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return formatProject(project);
    }, { params: t.Object({ ref: t.String() }) })
    .get("/v1/projects/:ref/api-keys", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [
            { name: "anon", api_key: project.anon_key || "anon" },
            { name: "service_role", api_key: project.service_key || "service" }
        ];
    }, { params: t.Object({ ref: t.String() }) })
    .get("/v1/projects/:ref/functions", () => [])
    .get("/v1/projects/:ref/edge-functions", () => [])
    .get("/v1/projects/:ref/analytics/log-drains", () => ({ data: [] }))
    .get("/v1/projects/:ref/permissions", () => [])
    .get("/v1/projects/:ref/config/auth", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return { jwt_secret: project.jwt_secret || "secret", enabled: true };
    }, { params: t.Object({ ref: t.String() }) })

    // --- Projects (platform) ---
    .get("/platform/projects", async () => {
        const projects = await projectService.listProjects();
        return projects.map(formatProject);
    })
    .get("/platform/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return formatProject(project);
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/projects/:ref/permissions", () => [])
    .get("/platform/projects/:ref/config", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            project_id: project.id, jwt_secret: project.jwt_secret || "secret",
            db_host: "localhost", db_name: project.database?.name || "postgres",
            db_user: "postgres", db_pass: "postgres", db_port: 5432
        };
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/projects/:ref/analytics/log-drains", () => ({ data: [] }))
    .get("/platform/projects/:ref/settings", async () => ({
        // 提供足够的字段防止前端崩溃
        database: { pool_mode: "transaction" },
        auth: { site_url: "http://localhost:3000" },
        api: { port: 9090 }
    }))
    .get("/platform/projects/:ref/databases", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [{
            id: project.id,
            name: project.database?.name || "postgres",
            host: "localhost",
            port: 5432,
            status: "ACTIVE_HEALTHY"
        }];
    }, { params: t.Object({ ref: t.String() }) })

    // --- pg-meta (platform) ---
    .guard({ params: t.Object({ ref: t.String() }) }, app => app
        .derive(async ({ params, query }) => {
            const project = await getProjectOrThrow(params.ref);
            const dbUser = dbConfig.username || "postgres";
            const dbPass = dbConfig.password || "postgres";
            const dbHost = dbConfig.hostname || "127.0.0.1";
            const dbPort = project.database?.port || 5432;
            const dbName = project.database?.name || `supa_${project.ref}`;
            const connectionString = `postgres://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}`;
            logger.info(`[PgMeta] Connecting with: postgres://${dbUser}:***@${dbHost}:${dbPort}/${dbName} (Pass length: ${dbPass?.length})`);
            const meta = pgMetaManager.getInstance(connectionString);
            const metaOpts = {
                includeSystemSchemas: query.include_system_schemas === 'true',
                limit: query.limit ? Number(query.limit) : undefined,
                offset: query.offset ? Number(query.offset) : undefined,
            };
            return { meta, metaOpts };
        })
        .get("/platform/pg-meta/:ref/tables", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.tables.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return data;
        })
        .get("/platform/pg-meta/:ref/views", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.views.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return data;
        })
        .get("/platform/pg-meta/:ref/roles", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.roles.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return data;
        })
        .get("/platform/pg-meta/:ref/schemas", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.schemas.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return data;
        })
        .get("/platform/pg-meta/:ref/materialized-views", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.materializedViews.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return data;
        })
        .get("/platform/pg-meta/:ref/publications", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.publications.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return data;
        })
        .get("/platform/pg-meta/:ref/types", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.types.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return data;
        })
        // Query usually uses POST, but we proxy GET for specific checks
        .get("/platform/pg-meta/:ref/query", async () => ({ rows: [] }))
    );
// Backward compatibility exports
export const studioV1Routes = studioRoutes;
export const studioAuthRoutes = studioRoutes;
