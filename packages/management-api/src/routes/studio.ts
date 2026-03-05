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
    organization_id: "esgfarm",
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
            organizations: [{ id: "esgfarm", name: "esgfarm", slug: "esgfarm", projects: projects.map(toPlatformProject) }]
        };
    })
    .get("/config", async () => ({ platform_name: "SupaCloud", features: { analytics: true, storage: true, functions: true } }))
    .get("/platform/organizations", async () => [{ id: "esgfarm", name: "esgfarm", slug: "esgfarm" }])
    .get("/platform/organizations/:slug", async () => ({ id: "esgfarm", name: "esgfarm", slug: "esgfarm", plan: "pro" }))
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

    // pg-meta 接口
    .get("/pg-meta/:ref/tables", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        const tables = await db`SELECT (table_schema || '.' || table_name) as id, table_name as name, table_schema as schema FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`;
        return tables;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/pg-meta/:ref/views", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        return await db`SELECT (table_schema || '.' || table_name) as id, table_name as name, table_schema as schema FROM information_schema.views WHERE table_schema NOT IN ('information_schema', 'pg_catalog')`;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/pg-meta/:ref/roles", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        return await db`SELECT oid as id, rolname as name FROM pg_roles`;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/pg-meta/:ref/schemas", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        const db = getProjectDb(project.database?.name || "postgres");
        return await db`SELECT schema_name as id, schema_name as name FROM information_schema.schemata WHERE schema_name NOT IN ('information_schema', 'pg_catalog')`;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/pg-meta/:ref/materialized-views", async () => [])
    .get("/pg-meta/:ref/publications", async () => [])
    .get("/pg-meta/:ref/types", async () => []);

// --- V1 API Routes ---
export const studioV1Routes = new Elysia({ prefix: "/v1" })
    .get("/organizations", async () => [{ id: "esgfarm", name: "esgfarm", slug: "esgfarm" }])
    .get("/projects", async () => {
        const projects = await projectService.listProjects();
        return projects.map(p => ({ id: p.id, ref: p.ref, name: p.name, organization_id: "esgfarm" }));
    })
    .get("/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return toPlatformProject(project);
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
    }, { params: t.Object({ ref: t.String() }) });

// --- Auth Routes ---
export const studioAuthRoutes = new Elysia({ prefix: "/auth" })
    .get("/session", async () => ({ user: { id: "1", email: "admin@supacloud.local" } }))
    .get("/user", async () => ({ id: "1", email: "admin@supacloud.local" }));
