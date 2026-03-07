import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { logger } from "../utils/logger";
import { db, getProjectDb, dbConfig } from "../db";
import { pgMetaManager } from "../db/pg-meta";

/**
 * 核心助手：确保返回的对象永远支持 .find 方法，即便它是空数组。
 * 返回纯数组，JSON 序列化时不会被污染。
 */
const ensureArray = <T>(arr: T[] | null | undefined): T[] => {
    return Array.isArray(arr) ? arr : [];
};

const getProjectOrThrow = async (ref: string) => {
    const isSpecialRef = ref === "default" || /^[a-z0-9]{10,20}$/.test(ref);
    try {
        let project: any = null;
        if (!isSpecialRef) {
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

const formatProject = (project: any, requestedRef?: string) => {
    const projectId = "1";
    const orgId = 1;
    const activeRef = requestedRef || project.ref || "default";

    // V1ProjectResponse 格式（来自 api.d.ts）
    return {
        id: projectId,
        ref: activeRef,
        name: project.name,
        status: "ACTIVE_HEALTHY",
        region: project.region || "us-east-1",
        organization_id: String(orgId),
        organization_slug: "default",
        created_at: project.created_at || new Date().toISOString(),
        // 扩展字段
        organization: {
            id: orgId,
            name: project.organization?.name || "Default Organization",
            slug: "default",
            subscription: { id: "sub_local", plan: { id: "pro", name: "Pro" } }
        },
        cloud_provider: project.cloud_provider || "aws",
        inserted_at: project.created_at || new Date().toISOString(),
        updated_at: project.updated_at || project.created_at || new Date().toISOString(),
        databases: ensureArray([
            {
                id: projectId,
                identifier: activeRef,
                name: project.database?.name || `supa_${activeRef}`,
                status: "ACTIVE",
                infra_compute_size: "nano"
            }
        ]),
        services: ensureArray([
            { id: "s1", name: "database", type: "database", status: "ACTIVE" },
            { id: "s2", name: "auth", type: "gotrue", status: "ACTIVE" },
            { id: "s3", name: "gotrue", type: "gotrue", status: "ACTIVE" },
            { id: "s4", name: "storage", type: "storage", status: "ACTIVE" },
            { id: "s5", name: "functions", type: "functions", status: "ACTIVE" },
            { id: "s6", name: "realtime", type: "realtime", status: "ACTIVE" },
            { id: "s7", name: "postgrest", type: "postgrest", status: "ACTIVE" },
            { id: "s8", name: "api", type: "postgrest", status: "ACTIVE" }
        ]),
        members: ensureArray([{ id: "1", user: { id: "1", email: "admin@supacloud.local" } }]),
        permissions: ensureArray(["all"]),
        feature_flags: ensureArray([]),
        custom_domains: ensureArray([]),
        db_host: project.db_host || "localhost",
        db_name: project.database?.name || `supa_${activeRef}`,
        db_port: project.database?.port || 5432,
        db_user: "postgres",
        db_pass: "postgres",
        db_ssl: false,
        owner_id: "1",
        is_paused: false
    };
};

/**
 * 统一导出所有 Studio 兼容路由。
 * 注意：所有路径都包含在 /api 前缀下（在 index.ts 中挂载）。
 * 这里的路径从 /platform 或 /v1 开始。
 */
const getAdminUsers = () => {
    const adminEmail = process.env.SUPACLOUD_ADMIN_EMAIL || "admin@esgfarm.cn";
    const adminPassword = process.env.SUPACLOUD_ADMIN_PASSWORD || "Supacloud@2026!";
    const adminName = process.env.SUPACLOUD_ADMIN_NAME || "Admin";
    
    return [
        { id: "1", email: adminEmail, password: adminPassword, name: adminName, role: "owner" }
    ];
};

const JWT_SECRET = process.env.SUPACLOUD_JWT_SECRET || "supacloud-secret-key-change-in-production";

const generateToken = (userId: string) => {
    const crypto = require("crypto");
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
        sub: userId,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 86400
    })).toString("base64url");
    const signature = crypto
        .createHmac("sha256", JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest("base64url");
    return `${header}.${payload}.${signature}`;
};

export const studioRoutes = new Elysia()
    // --- Auth & Profile ---
    .post("/api/platform/login", async ({ body, set }) => {
        const bodyAny = body as any;
        const email = bodyAny?.email || "";
        const password = bodyAny?.password || "";
        
        const adminUsers = getAdminUsers();
        const admin = adminUsers.find(u => u.email === email && u.password === password);
        
        if (!admin) {
            set.status = 401;
            return { error: "Invalid credentials", message: "邮箱或密码错误" };
        }
        
        return {
            access_token: generateToken(admin.id),
            token_type: "bearer",
            expires_in: 86400,
            user: {
                id: admin.id,
                email: admin.email,
                user_metadata: { name: admin.name, role: admin.role },
                app_metadata: { provider: "email", role: admin.role }
            }
        };
    }, { body: t.Optional(t.Any()) })
    .post("/api/platform/signup", async ({ set }) => {
        set.status = 403;
        return { 
            error: "Registration disabled", 
            message: "注册已关闭，请联系管理员获取账号" 
        };
    })
    .post("/api/platform/logout", () => ({ success: true }))
    .get("/api/platform/auth/sso", async ({ set }) => {
        set.status = 400;
        return { 
            error: "SSO disabled", 
            message: "SSO 登录未启用，请使用邮箱密码登录" 
        };
    })
    .get("/api/platform/auth/github", async ({ set }) => {
        set.status = 400;
        return { 
            error: "GitHub auth disabled", 
            message: "GitHub 登录未启用，请使用邮箱密码登录" 
        };
    })
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
    .get("/api/platform/profile", async ({ headers }) => {
        const referer = headers['referer'] || "";
        const refMatch = referer.match(/\/project\/([a-z0-9]{1,20})/);
        const requestedRef = refMatch ? refMatch[1] : "default";

        const projects = await projectService.listProjects();
        const baseProject = (projects && projects.length > 0) ? projects[0] : null;
        const formattedBaseProject = baseProject ? formatProject(baseProject, requestedRef) : null;
        
        const projectsList = formattedBaseProject ? [formattedBaseProject] : [];

        // 核心对齐：使用真实组织 ID 和字段
        const defaultOrg = { 
            id: 1, 
            name: "Default Organization", 
            slug: "default", 
            projects: projectsList,
            members: ensureArray([{ id: "1", is_owner: true, user: { id: "1", email: "admin@supacloud.local" } }]),
            roles: ensureArray([{ id: "1", name: "Owner" }]),
            feature_flags: ensureArray([]),
            subscription: { id: "sub_local", plan: { id: "pro", name: "Pro" } }
        };

        const organizations = [defaultOrg];

        // ProfileResponse 格式（来自 platform.d.ts）
        const resp = {
            id: 1,
            primary_email: "admin@supacloud.local",
            username: "admin",
            first_name: "Admin",
            last_name: "User",
            auth0_id: "auth0|admin",
            gotrue_id: "admin-gotrue-id",
            disabled_features: [],
            free_project_limit: 10,
            is_alpha_user: false,
            is_sso_user: false,
            mobile: null,
            organizations: organizations
        };
        logger.info(`[Studio API] /profile response size: ${JSON.stringify(resp).length}`);
        return resp;
    })
    .get("/api/platform/account/me", () => ({
        id: "1",
        primary_email: "admin@supacloud.local",
        username: "admin",
        organizations: [{ id: "default", name: "Default Organization", slug: "default" }]
    }))
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
    // OrganizationResponse 格式（来自 platform.d.ts）
    .get("/api/v1/organizations", () => [
        { id: 1, name: "Default Organization", slug: "default" }
    ])
    .get("/api/platform/organizations", () => [
        {
            id: 1,
            name: "Default Organization",
            slug: "default",
            billing_email: "admin@supacloud.local",
            billing_partner: null,
            is_owner: true,
            opt_in_tags: [],
            organization_missing_address: false,
            organization_requires_mfa: false,
            plan: { id: "pro", name: "Pro" },
            restriction_data: null,
            restriction_status: null,
            stripe_customer_id: null,
            subscription_id: null,
            usage_billing_enabled: false
        }
    ])
    .get("/api/platform/organizations/:slug/members", () => ensureArray([{ id: "1", is_owner: true, user: { id: "1", email: "admin@supacloud.local" } }]))
    .get("/api/platform/organizations/:slug/roles", () => ensureArray([{ id: "1", name: "Owner" }]))
    .get("/api/platform/organizations/:slug/permissions", () => ensureArray(["all"]))
    .get("/api/v1/projects/:ref/organizations", () => [{ id: 1, name: "Default Organization", slug: "default" }])
    .get("/api/platform/organizations/:slug", () => ({ 
        id: 1, 
        name: "Default Organization", 
        slug: "default", 
        plan: { id: "pro", name: "Pro" },
        billing_email: "admin@supacloud.local",
        billing_partner: null,
        is_owner: true,
        opt_in_tags: [],
        organization_missing_address: false,
        organization_requires_mfa: false,
        restriction_data: null,
        restriction_status: null,
        stripe_customer_id: null,
        subscription_id: null,
        usage_billing_enabled: false
    }))

    // --- Projects (v1) ---
    .get("/api/v1/projects", async () => {
        const projects = await projectService.listProjects();
        if (projects.length === 0) return [];
        // 关键：对齐全局唯一的 default 项目
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
    .get("/api/v1/projects/:ref/functions", () => ensureArray([]))
    .get("/api/v1/projects/:ref/edge-functions", () => ensureArray([]))
    .get("/api/v1/projects/:ref/analytics/log-drains", () => ({ data: ensureArray([]) }))
    .get("/api/v1/projects/:ref/permissions", () => ensureArray(["all"]))
    .get("/api/v1/projects/:ref/config/auth", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return { jwt_secret: project.jwt_secret || "secret", enabled: true };
    }, { params: t.Object({ ref: t.String() }) })

    // --- Projects (platform) ---
    .get("/api/platform/projects", async () => {
        const projects = await projectService.listProjects();
        const formattedProjects = Array.isArray(projects) ? projects.map(p => formatProject(p)) : [];
        return formattedProjects;
    })
    .get("/api/platform/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        // 单个项目详情返回扁平对象，但 Studio 有时会在列表上下文通过 ref 查找
        return formatProject(project);
    }, { params: t.Object({ ref: t.String() }) })
    .get("/api/platform/projects/:ref/permissions", () => ensureArray(["all"]))
    .get("/api/platform/projects/:ref/features", () => ensureArray([
        { id: "analytics", name: "Analytics", enabled: true },
        { id: "storage", name: "Storage", enabled: true },
        { id: "auth", name: "Auth", enabled: true }
    ]))
    .get("/api/platform/projects/:ref/feature-flags", () => ensureArray([]))
    .get("/api/platform/projects/:ref/custom-domains", () => ensureArray([]))
    .get("/api/platform/organizations/:slug/feature-flags", () => ensureArray([]))
    .get("/api/platform/organizations/:slug/members", () => ensureArray([{ id: "1", is_owner: true, user: { id: "1", email: "admin@supacloud.local" } }]))
    .get("/api/platform/organizations-list", async () => {
        // 补全组织列表，Studio 初始化必需。ID 需对齐 profile 接口。
        return [
            { id: "default", name: "Default Organization", slug: "default", billing_email: "admin@supacloud.local" }
        ];
    })
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
        // 提供极致完整的结构，防止前端多级解构后在 undefined 上调用 find
        database: { pool_mode: "transaction", status: "ACTIVE_HEALTHY" },
        auth: { site_url: "http://localhost:3000", additional_redirect_urls: ensureArray([]) },
        api: { port: 9090, max_rows: 1000 },
        storage: { enabled: true, file_size_limit: 52428800 }
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
        const dbData = [{
            id: project.id,
            name: project.database?.name || "postgres",
            host: "localhost",
            db_user: "postgres",
            db_pass: "postgres",
            db_port: 5432,
            port: 5432,
            status: "ACTIVE_HEALTHY"
        }];
        logger.info(`[Studio API] /databases response: ${JSON.stringify(dbData)}`);
        return { data: dbData };
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
        // 关键对齐：Tables 列表必须包裹在 data 中
        return { data };
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

                logger.info(`[Query] Executing on ${dbName}: ${queryText.substring(0, 50)}... (key: ${query.key || 'none'})`);
                const queryResult = await db.executeQuery(dbName, queryText);
                let rows = queryResult.rows as any[];
                
                // 1. 处理多结果集
                if (Array.isArray(rows) && rows.length > 0 && Array.isArray(rows[0])) {
                    rows = (rows.find(r => Array.isArray(r) && r.length > 0) || rows[rows.length - 1]) as any[];
                }

                // 2. 指纹判定与自适应包装逻辑
                const isMetadataKey = !!query.key;
                const isSystemTableQuery = queryText.toLowerCase().includes('information_schema') ||
                                         queryText.toLowerCase().includes('pg_catalog');
                // 关键识别点：如果是报告查询 (pg_stat_statements, pg_stat_activity 等)，Studio 期望 200 状态码下的扁平数组
                const isReportQuery = queryText.toLowerCase().includes('pg_stat_statements') || 
                                     queryText.toLowerCase().includes('pg_stat_activity') ||
                                     queryText.toLowerCase().includes('pg_authid');

                // 检查是否已经由 pg-meta 完成了 json 封装 (包含 data 键)
                const hasDataEnvelope = rows.length === 1 && rows[0] && typeof rows[0] === 'object' && 'data' in rows[0];

                if (hasDataEnvelope) {
                    const innerData = rows[0].data;
                    // 如果是工具链对象 (entity-types, fdws 等)，Studio 期望结构为 { data: { count, entities } }
                    // 源码级对齐：src/data/entity-types/entity-types-infinite-query.ts
                    // 内部使用 jsonb_build_object 已经封装了 { entities, count }
                    const isToolchainObject = innerData && typeof innerData === 'object' && 
                                           ('entities' in innerData || 'count' in innerData || 'item' in innerData);

                    if (isToolchainObject) {
                        logger.info(`[Query] Result is toolchain object, precisely aligning as { data: ... }`);
                        // 返回行中的第一个对象，即匹配 result[0] 的解构逻辑
                        return new Response(JSON.stringify(rows[0]), { 
                            headers: { 'Content-Type': 'application/json' } 
                        });
                    }
                    
                    // 如果内部 data 是个普通列表且带有 key，通常需要扁平化
                    if (isMetadataKey && Array.isArray(innerData)) {
                        logger.info(`[Query] Result is nested data list with key, flattening.`);
                        return new Response(JSON.stringify(innerData), { 
                            headers: { 'Content-Type': 'application/json' } 
                        });
                    }
                }

                // 3. 兜底逻辑：针对不同的请求场景返回官方标准格式
                
                // 情况 A：元数据列表请求 或 性能报告请求 -> 必须返回 200 状态码 + 扁平数组
                if (isMetadataKey || isSystemTableQuery || isReportQuery) {
                    return new Response(JSON.stringify(ensureArray(rows)), { 
                        status: 200,
                        headers: { 'Content-Type': 'application/json' } 
                    });
                }

                // 情况 B：SQL Workspace 手动按钮点击运行 -> 期望返回 201 状态码 + [{ data: rows }] 包装
                set.status = 201; 
                const wrappedRows = ensureArray(rows.map(r => ({ data: r })));
                if (wrappedRows.length === 0) wrappedRows.push({ data: [] });

                const resultResp = new Response(JSON.stringify(wrappedRows), { 
                    status: 201,
                    headers: { 'Content-Type': 'application/json' } 
                });
                logger.info(`[Query Result] Type: Workspace, Rows: ${rows.length}`);
                return resultResp;
            } catch (error) {
                logger.warn(`[Query Error] ${error instanceof Error ? error.message : String(error)}`);
                const errResp = ensureArray([]);
                return new Response(JSON.stringify(errResp), { headers: { 'Content-Type': 'application/json' } });
            }
        })
        .get("/api/platform/pg-meta/:ref/query", async () => ensureArray([]))
    )
    
    // --- Incident Status ---
    .get("/api/incident-status", () => ({
        incidents: [],
        message: "All systems operational"
    }))
    
    // --- GoTrue compatibility (for login page) ---
    .post("/auth/v1/token", async ({ body, set }) => {
        const bodyAny = body as any;
        const grantType = bodyAny?.grant_type || "password";
        
        if (grantType === "password") {
            const email = bodyAny?.email || "";
            const password = bodyAny?.password || "";
            
            const adminUsers = getAdminUsers();
            const admin = adminUsers.find(u => u.email === email && u.password === password);
            
            if (!admin) {
                set.status = 400;
                return { 
                    error: "invalid_grant", 
                    error_description: "Invalid login credentials" 
                };
            }
            
            return {
                access_token: generateToken(admin.id),
                token_type: "bearer",
                expires_in: 86400,
                refresh_token: generateToken(admin.id),
                user: {
                    id: admin.id,
                    email: admin.email,
                    aud: "authenticated",
                    role: "authenticated",
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    user_metadata: { name: admin.name, role: admin.role },
                    app_metadata: { provider: "email", role: admin.role }
                }
            };
        }
        
        set.status = 400;
        return { error: "unsupported_grant_type" };
    }, { body: t.Optional(t.Any()) })
    .get("/auth/v1/user", () => ({
        id: "1",
        email: "admin@supacloud.local",
        aud: "authenticated",
        role: "authenticated",
        created_at: new Date().toISOString(),
        user_metadata: { name: "Admin" }
    }));

// Backward compatibility exports
export const studioV1Routes = studioRoutes;
export const studioAuthRoutes = studioRoutes;
