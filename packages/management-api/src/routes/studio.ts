import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { logger } from "../utils/logger";
import { db, getProjectDb } from "../db";

/**
 * 核心助手：处理项目引用。
 * 关键点：Studio 可能会随机生成一个 ref（如 pyayjnscjk）。
 * 解决 Studio 随机 ID 问题。
 */
const getProjectOrThrow = async (ref: string) => {
    try {
        let project: any = await projectService.getProject(ref);
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

const toPlatformProject = (project: any) => ({
    id: project.id,
    ref: project.ref,
    name: project.name,
    status: "ACTIVE_HEALTHY",
    region: "local",
    organization_id: "default",
    cloud_provider: "localhost",
    inserted_at: project.created_at,
    updated_at: project.updated_at || null,
    // 以下字段对激活 Studio 菜单至关重要
    services: ["database", "auth", "storage", "functions"],
    db_host: "localhost",
    db_name: project.database?.name || `supa_${project.ref}`,
    db_port: 5432,
    db_user: "postgres",
    db_ssl: false,
});

// --- Platform API Routes ---
export const studioRoutes = new Elysia()
    .get("/platform/auth/user", async () => ({
        id: "1", email: "admin@supacloud.local", aud: "authenticated", role: "authenticated",
        user_metadata: { first_name: "Admin" }
    }))
    .get("/platform/profile", async () => {
        const projects = await projectService.listProjects();
        return {
            id: 1, primary_email: "admin@supacloud.local",
            organizations: [{ id: "default", name: "default", slug: "default", projects: projects.map(toPlatformProject) }]
        };
    })
    .get("/config", async () => ({ platform_name: "SupaCloud", features: { analytics: true, storage: true, functions: true } }))
    .get("/platform/organizations", async () => [{ id: "default", name: "default", slug: "default" }])
    .get("/platform/organizations/:slug", async () => ({ id: "default", name: "default", slug: "default", plan: "pro" }))
    .get("/platform/projects", async () => {
        const projects = await projectService.listProjects();
        return projects.map(toPlatformProject);
    })
    .get("/platform/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return toPlatformProject(project);
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/projects/:ref/config", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            project_id: project.id, jwt_secret: project.jwt_secret || "secret",
            db_host: "localhost", db_name: project.database?.name || "postgres",
            db_user: "postgres", db_pass: "postgres", db_port: 5432
        };
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/projects/:ref/api-keys", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [
            { name: "anon", api_key: project.anon_key || "anon" },
            { name: "service_role", api_key: project.service_key || "service" }
        ];
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/projects/:ref/analytics/log-drains", async () => ({ data: [] }))

    // pg-meta 接口 (Studio 请求 /api/platform/pg-meta/:ref/...)
    .get("/platform/pg-meta/:ref/tables", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        const tables = await db`SELECT (table_schema || '.' || table_name) as id, table_name as name, table_schema as schema FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`;
        return tables;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/pg-meta/:ref/views", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        return await db`SELECT (table_schema || '.' || table_name) as id, table_name as name, table_schema as schema FROM information_schema.views WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/pg-meta/:ref/roles", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        return await db`SELECT oid as id, rolname as name FROM pg_roles`;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/pg-meta/:ref/schemas", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        return await db`SELECT schema_name as id, schema_name as name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog')`;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/pg-meta/:ref/materialized-views", async () => [])
    .get("/platform/pg-meta/:ref/publications", async () => [])
    .get("/platform/pg-meta/:ref/types", async () => [])
    .get("/platform/pg-meta/:ref/columns", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        return await db`SELECT column_name as name, table_name, table_schema, data_type FROM information_schema.columns WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/pg-meta/:ref/primary-keys", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        return await db`SELECT kcu.column_name, kcu.table_name, kcu.table_schema FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name WHERE tc.constraint_type = 'PRIMARY KEY' AND kcu.table_schema NOT IN ('information_schema', 'pg_catalog')`;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/platform/pg-meta/:ref/relationships", async () => []);

// --- V1 API Routes ---
export const studioV1Routes = new Elysia({ prefix: "/v1" })
    .get("/organizations", async () => [{ id: "default", name: "default", slug: "default" }])
    .get("/projects", async () => {
        const projects = await projectService.listProjects();
        return projects.map(p => ({ id: p.id, ref: p.ref, name: p.name, organization_id: "default" }));
    })
    .get("/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            ...toPlatformProject(project),
            // Additional fields for Project Settings menu
            database: {
                identifier: project.database?.name || `supa_${project.ref}`,
                host: "localhost",
                port: 5432,
                version: "15.0",
                postgres_engine: "15.0",
                release_channel: "stable",
            },
            services: [
                { name: "PostgreSQL", status: "ACTIVE_HEALTHY" },
                { name: "PostgREST", status: "ACTIVE_HEALTHY" },
                { name: "GoTrue", status: "ACTIVE_HEALTHY" },
                { name: "Realtime", status: "ACTIVE_HEALTHY" },
                { name: "Storage", status: "ACTIVE_HEALTHY" },
                { name: "Kong", status: "ACTIVE_HEALTHY" },
            ],
            endpoint: `https://${project.ref}.default.cn`,
            anon_key: project.anon_key || "anon-key",
            service_key: project.service_key || "service-key",
            jwt_secret: project.jwt_secret || "jwt-secret",
        };
    }, { params: t.Object({ ref: t.String() }) })
    .get("/projects/:ref/api-keys", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [
            { name: "anon", api_key: project.anon_key || "anon" },
            { name: "service_role", api_key: project.service_key || "service" }
        ];
    }, { params: t.Object({ ref: t.String() }) })
    .get("/projects/:ref/functions", async () => [])
    .get("/projects/:ref/edge-functions", async () => [])
    .get("/projects/:ref/analytics/log-drains", async () => ({ data: [] }))
    .get("/projects/:ref/config/auth", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return { jwt_secret: project.jwt_secret || "secret", enabled: true };
    }, { params: t.Object({ ref: t.String() }) })
    .get("/projects/:ref/config/database", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            db_host: "localhost",
            db_name: project.database?.name || `supa_${project.ref}`,
            db_port: 5432,
            db_user: "postgres",
            db_ssl: false,
        };
    }, { params: t.Object({ ref: t.String() }) })
    .get("/projects/:ref/config/storage", async () => ({ enabled: true }))
    .get("/projects/:ref/config/realtime", async () => ({ enabled: true }))
    .get("/projects/:ref/config/functions", async () => ({ enabled: true }))
    .get("/projects/:ref/config/api", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            api_url: `https://${project.ref}.default.cn`,
            db_schema: "public",
            db_anon_role: "anon",
        };
    }, { params: t.Object({ ref: t.String() }) })
    .get("/projects/:ref/settings", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            name: project.name,
            ref: project.ref,
            organization_id: "default",
            region: "local",
            cloud_provider: "localhost",
            status: "ACTIVE_HEALTHY",
        };
    }, { params: t.Object({ ref: t.String() }) });

// --- Auth Routes ---
export const studioAuthRoutes = new Elysia({ prefix: "/auth" })
    .get("/session", async () => ({ user: { id: "1", email: "admin@supacloud.local" } }))
    .get("/user", async () => ({ id: "1", email: "admin@supacloud.local" }));
