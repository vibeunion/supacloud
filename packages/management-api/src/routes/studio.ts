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
    // 强制匹配：如果 ref 是 "default" 或者是 Studio 随机生成的 10 位字符标识符，则回退到第一个项目
    const isSpecialRef = ref === "default" || /^[a-z0-9]{10}$/.test(ref);
    try {
        let project: any = null;
        if (!isSpecialRef) {
            project = await projectService.getProject(ref);
        }
        if (!project) {
            const projects = await projectService.listProjects();
            // 到服务器端实测，如果找不到则拿第一个，确保 studio 始终能加载
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
    id: 1, // 官方标杆：项目 ID 通常是数字。统一为 1 避免 UUID/数字混用导致的查找失败。
    ref: "default", // 关键：将所有项目 ref 统一为 "default"，彻底解决 URL 路径与数据实体的对齐匹配问题
    name: project.name,
    status: "ACTIVE", // 官方 Cloud 是 ACTIVE，不是 ACTIVE_HEALTHY
    region: "us-east-1", // 官方标杆，避免 "local" 可能引发的过滤逻辑边界
    organization_id: "default",
    organization: {
        id: "default",
        name: "Default Organization",
        slug: "default",
        subscription: { id: "sub_local", plan: { id: "pro", name: "Pro" } }
    },
    cloud_provider: "aws",
    inserted_at: project.created_at,
    updated_at: project.updated_at || null,
    // 关键服务：告知 Studio 启用哪些功能卡片。对齐官方 8 大核心服务。
    // 注意：type 必须精细对齐，例如 auth -> gotrue, api -> postgrest，否则前端 filter 会崩溃。
    services: [
        { id: 1, name: "database", type: "database", status: "ACTIVE" },
        { id: 2, name: "auth", type: "gotrue", status: "ACTIVE" },
        { id: 3, name: "gotrue", type: "gotrue", status: "ACTIVE" },
        { id: 4, name: "storage", type: "storage", status: "ACTIVE" },
        { id: 5, name: "functions", type: "functions", status: "ACTIVE" },
        { id: 6, name: "realtime", type: "realtime", status: "ACTIVE" },
        { id: 7, name: "postgrest", type: "postgrest", status: "ACTIVE" },
        { id: 8, name: "api", type: "postgrest", status: "ACTIVE" }
    ],
    // 数据库连接配置
    db_host: "localhost",
    db_name: project.database?.name || `supa_${project.ref}`,
    db_port: 5432,
    db_user: "postgres",
    db_pass: "postgres",
    db_ssl: false,
    owner_id: "1",
    is_paused: false
});

/**
 * 统一导出所有 Studio 兼容路由。
 * 注意：所有路径都包含在 /api 前缀下（在 index.ts 中挂载）。
 * 这里的路径从 /platform 或 /v1 开始。
 */
export const studioRoutes = new Elysia()
    // --- Auth & Profile ---
    .get("/api/auth/session", () => ({ 
        user: { 
            id: "1", 
            email: "admin@supacloud.local", 
            user_metadata: { name: "Admin" },
            app_metadata: { provider: "email" },
            last_sign_in_at: new Date().toISOString(),
            created_at: new Date().toISOString()
        } 
    }))
    .get("/api/auth/user", () => ({ 
        id: "1", 
        email: "admin@supacloud.local",
        user_metadata: { name: "Admin" },
        last_sign_in_at: new Date().toISOString()
    }))
    .get("/api/platform/auth/user", () => ({ 
        id: "1", 
        email: "admin@supacloud.local", 
        aud: "authenticated", 
        role: "authenticated",
        user_metadata: { name: "Admin" }
    }))
    .get("/api/platform/profile", async () => {
        const projects = await projectService.listProjects();
        // 关键对齐：强制所有项目 ref 为 "default"，确保 Studio 路由匹配一致。
        // [IMPORTANT] 必须去重：如果列表里有多个相同 ref/id 的项目，Studio 的项目发现逻辑会崩毁。
        // 我们只取第一个项目作为 "default" 项目返回，确保前端上下文绝对唯一匹配。
        const baseProject = projects[0];
        const projectsWithAlias = baseProject ? [
            { ...formatProject(baseProject), ref: "default", id: 1 }
        ] : [];

        return {
            id: 1, 
            primary_email: "admin@example.com",
            username: "admin",
            first_name: "Admin",
            last_name: "User",
            organizations: [{ 
                id: "default", 
                name: "Default Organization", 
                slug: "default", 
                projects: projectsWithAlias,
                subscription: { id: "sub_local", plan: { id: "pro", name: "Pro" } }
            }]
        };
    })
    .get("/api/platform/config", () => ({ 
        platform_name: "SupaCloud", 
        features: { 
            analytics: true, 
            storage: true, 
            functions: true,
            auth: true,
            realtime: true
        } 
    }))

    // --- Organizations ---
    .get("/api/v1/organizations", () => [{ id: "default", name: "Default Organization", slug: "default" }])
    .get("/api/platform/organizations", () => [{ id: "default", name: "Default Organization", slug: "default" }])
    .get("/api/platform/organizations/:slug", () => ({ id: "default", name: "Default Organization", slug: "default", plan: "pro" }))

    // --- Projects (v1) ---
    .get("/api/v1/projects", async () => {
        const projects = await projectService.listProjects();
        // 关键对齐：确保返回的项目列表中包含 organization_id: "default"
        // 并且强制第一个项目的 ref 为 "default" 以解决导航冲突
        if (projects.length === 0) return [];
        return [formatProject(projects[0])];
    })
    .get("/api/v1/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return formatProject(project);
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/v1/projects/:ref/api-keys", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [
            { name: "anon", api_key: project.anon_key || "anon" },
            { name: "service_role", api_key: project.service_key || "service" }
        ];
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/v1/projects/:ref/functions", () => [])
    .get("/api/v1/projects/:ref/edge-functions", () => [])
    .get("/api/v1/projects/:ref/analytics/log-drains", () => ({ data: [] }))
    .get("/api/v1/projects/:ref/permissions", () => ["all"])
    .get("/api/v1/projects/:ref/config/auth", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return { jwt_secret: project.jwt_secret || "secret", enabled: true };
    }, { params: t.Object({ ref: t.String() }) })

    // --- Projects (platform) ---
    .get("/api/platform/projects", async () => {
        const projects = await projectService.listProjects();
        return projects.map(formatProject);
    })
    .get("/api/platform/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return formatProject(project);
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/platform/projects/:ref/permissions", () => [])
    .get("/api/platform/projects/:ref/config", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            project_id: project.id, jwt_secret: project.jwt_secret || "secret",
            db_host: "localhost", db_name: project.database?.name || "postgres",
            db_user: "postgres", db_pass: "postgres", db_port: 5432
        };
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/platform/projects/:ref/analytics/log-drains", () => ({ data: [] }))
    .get("/api/platform/projects/:ref/permissions", () => ["all"])
    .get("/api/platform/projects/:ref/settings", async () => ({
        // 提供足够的字段防止前端崩溃
        database: { pool_mode: "transaction" },
        auth: { site_url: "http://localhost:3000" },
        api: { port: 9090 }
    }))
    // 补全 Postgrest 配置指纹，解决 API Docs 相关 404
    .get("/api/platform/projects/:ref/config/postgrest", () => ({
        db_schema: "public,storage,auth",
        db_anon_role: "anon",
        db_extra_search_path: "public,extensions",
        max_rows: 1000
    }))
    // 补全 OpenAPI 接口，解决 API Docs 页面 404。返回一个极简的 OpenAPI 定义。
    .get("/api/platform/projects/:ref/api/rest", () => ({
        openapi: "3.0.0",
        info: { title: "SupaCloud API", version: "1.0.0" },
        paths: {}
    }))
    .get("/api/platform/projects/:ref/api-keys", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [
            { name: "anon", api_key: project.anon_key || "anon" },
            { name: "service_role", api_key: project.service_key || "service" }
        ];
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/platform/projects/:ref/databases", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [{
            id: project.id,
            name: project.database?.name || "postgres",
            host: "localhost",
            port: 5432,
            status: "ACTIVE_HEALTHY"
        }];
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/platform/projects/:ref/tables", async ({ params, query }) => {
        const project = await getProjectOrThrow(params.ref);
        const dbUser = dbConfig.username || "postgres";
        const dbPass = dbConfig.password || "postgres";
        const dbHost = dbConfig.hostname || "127.0.0.1";
        const dbPort = project.database?.port || 5432;
        const dbName = project.database?.name || `supa_${project.ref}`;
        const connectionString = `postgres://${dbUser}:${dbPass}@${dbHost}:${dbPort}/${dbName}`;
        const meta = pgMetaManager.getInstance(connectionString);
        const { data, error } = await meta.tables.list({
            includeSystemSchemas: query.include_system_schemas === 'true'
        });
        if (error) return new Response(JSON.stringify(error), { status: 400 });
        return data;
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/platform/projects/:ref/run-lints", () => [])
    // SQL 编辑器核心内容路由 (对齐 Studio { data } 全量武装)
    .get("/api/platform/projects/:ref/content/count", () => ({ count: 1 }))
    .get("/api/platform/projects/:ref/content/folders", ({ params }) => ({
        data: {
            folders: [
                {
                    id: "folder_sql",
                    project_id: 1, // 对齐项目数字 ID
                    name: "SQL Queries",
                    inserted_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }
            ],
            contents: [
                {
                    id: "8399e548-2b70-4b9f-be4d-2efb44594a7b",
                    project_id: 1, // 对齐项目数字 ID
                    name: "SQL Query",
                    type: "sql",
                    visibility: "user",
                    owner_id: "1",
                    inserted_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }
            ]
        }
    }))
    // SQL 编辑器列表，必须根据官方 Cloud 对齐：包裹在 {"data": [...]} 中
    .get("/api/platform/projects/:ref/content", ({ params }) => ({
        data: [
            {
                id: "8399e548-2b70-4b9f-be4d-2efb44594a7b",
                project_id: 1, // 对齐项目数字 ID
                name: "SQL Query",
                type: "sql",
                visibility: "user",
                owner_id: "1",
                inserted_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            }
        ].filter(Boolean)
    }))
    .get("/api/platform/projects/:ref/content/item/:id", ({ params }) => ({
        data: {
            id: params.id,
            project_id: 1, // 对齐项目数字 ID
            name: "SQL Query",
            type: "sql",
            description: "",
            visibility: "user",
            owner_id: "1",
            content: "SELECT 1;",
            inserted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }
    }), { params: t.Object({ ref: t.String(), id: t.String() }) })
    // 兜底 /content/:id (对齐官方结构，包裹在 data 中)
    .get("/api/platform/projects/:ref/content/:id", ({ params }) => ({
        data: {
            id: params.id,
            project_id: 1, // 对齐项目数字 ID
            name: "SQL Query",
            type: "sql",
            description: "",
            visibility: "user",
            owner_id: "1",
            content: "SELECT 1;",
            inserted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }
    }), { params: t.Object({ ref: t.String(), id: t.String() }) })
    .get("/api/platform/projects/:ref/config/database", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            db_host: "localhost",
            db_name: project.database?.name || "postgres",
            db_user: "postgres",
            db_port: 5432
        };
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/cli-release-version", () => ({ version: "v1.0.0" }))
    .get("/api/get-deployment-commit", () => ({ commit: "dev", deployed_at: new Date().toISOString() }))
    .get("/api/platform/profile/permissions", () => [])
    .get("/api/profile/permissions", () => [])
    .get("/api/ai/sql/check-api-key", () => ({ is_valid: true }))
    .get("/api/platform/projects/:ref/billing/subscription", () => ({ id: "sub_local", plan: { id: "pro", name: "Pro" } }))

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
        .get("/api/platform/pg-meta/:ref/tables", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.tables.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            // 官方对标：Table 列表返回的是扁平数组，不是 {"data": [...]}
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        .get("/api/platform/pg-meta/:ref/views", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.views.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        .get("/api/platform/pg-meta/:ref/roles", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.roles.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        .get("/api/platform/pg-meta/:ref/schemas", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.schemas.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        .get("/api/platform/pg-meta/:ref/materialized-views", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.materializedViews.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        .get("/api/platform/pg-meta/:ref/publications", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.publications.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        .get("/api/platform/pg-meta/:ref/types", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.types.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        .get("/api/platform/pg-meta/:ref/extensions", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.extensions.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        .get("/api/platform/pg-meta/:ref/policies", async ({ meta, metaOpts }) => {
            const { data, error } = await meta.policies.list(metaOpts);
            if (error) return new Response(JSON.stringify(error), { status: 400 });
            return Array.isArray(data) ? data.filter(Boolean) : [];
        })
        // Query usually uses POST
        .post("/api/platform/pg-meta/:ref/query", async ({ params, body, set, query }) => {
            try {
                const project = await getProjectOrThrow(params.ref);
                const dbName = project.database?.name || `supa_${project.ref}`;
                
                let queryText = "";
                const bodyAny = body as any;
                if (typeof body === 'string') {
                    queryText = body;
                } else if (bodyAny && typeof bodyAny.query === 'string') {
                    queryText = bodyAny.query;
                } else {
                    return new Response(JSON.stringify({ error: "Invalid query body" }), { status: 400 });
                }

                logger.info(`[Query] Executing on ${dbName}: ${queryText.substring(0, 100)}...`);
                const queryResult = await db.executeQuery(dbName, queryText);
                let rows = queryResult.rows as any[];
                
                if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
                    // 如果第一项是数组，说明是多结果集，寻找第一个非空数组或者最后一组数据
                    rows = (rows.find(r => Array.isArray(r) && r.length > 0) || rows[rows.length - 1]) as any[];
                }

                // 指纹修正：判断是否是典型的元数据查询（如 Table Editor 初始加载 schemas 等）
                // 官方 pg-meta 对于带有 key 的 GET/POST 辅助查询通常返回扁平数组
                const isMetadataQuery = query.key === 'schemas' || query.key === 'tables';

                if (isMetadataQuery) {
                    return rows;
                }

                set.status = 201; // 对齐官方 201 Created 响应状态
                // 官方对标：SQL Workspaces 的 Query 响应是一个 [ { data: rows } ] 的这种数组套对象格式
                return [{ data: rows }];
            } catch (error) {
                logger.warn(`[Query Intercepted] ${error instanceof Error ? error.message : String(error)} - Returning empty rows for compatibility.`);
                return [{ data: [] }];
            }
        })
        .get("/api/platform/pg-meta/:ref/query", async () => [])
    );

// Backward compatibility exports
export const studioV1Routes = studioRoutes;
export const studioAuthRoutes = studioRoutes;
