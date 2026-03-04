import { Elysia, t } from "elysia";
import { projectService } from "../services";
import { logger } from "../utils/logger";

/**
 * Helper to handle project resolution including "default" alias
 */
const getProjectOrThrow = async (ref: string) => {
    let project: any = await projectService.getProject(ref);
    if (!project && ref === "default") {
        const projects = await projectService.listProjects();
        project = projects[0];
    }
    if (!project) {
        throw new Error("Project not found");
    }
    return project;
};

/**
 * Helper to format project for platform API
 */
const toPlatformProject = (project: any) => ({
    id: project.id,
    ref: project.ref,
    name: project.name,
    status: project.status?.toUpperCase() || "ACTIVE_HEALTHY",
    region: project.region || "local",
    organization_id: "default",
    cloud_provider: project.cloud_provider || "localhost",
    inserted_at: project.created_at,
    updated_at: project.updated_at || null,
});

export const studioRoutes = new Elysia({ prefix: "/platform" })
    // --- Auth & Profile ---
    .get("/auth/user", async () => ({
        id: "1",
        email: "admin@supacloud.local",
        user_metadata: { first_name: "Admin", last_name: "User" },
        app_metadata: {},
        aud: "authenticated",
        role: "authenticated",
        created_at: new Date().toISOString(),
    }))
    .get("/profile", async () => {
        const projects = await projectService.listProjects();
        return {
            id: 1,
            primary_email: "admin@supacloud.local",
            username: "admin",
            first_name: "Admin",
            last_name: "User",
            organizations: [{
                id: 1,
                name: "SupaCloud",
                slug: "supacloud",
                projects: projects.map(toPlatformProject)
            }]
        };
    })
    .get("/subscription", async () => ({
        id: 1,
        name: "Pro Plan",
        tier: "pro",
        billing_email: "admin@supacloud.local",
    }))
    .get("/config", async () => ({
        platform_name: "SupaCloud",
        features: { analytics: false, storage: true, functions: true }
    }))

    // --- Organizations ---
    .get("/organizations", async () => [
        { id: 1, name: "SupaCloud", slug: "supacloud" }
    ])
    .get("/organizations/:slug", async ({ params, set }) => {
        if (params.slug !== "supacloud" && params.slug !== "default") {
            set.status = 404;
            return { error: "Organization not found" };
        }
        return {
            id: 1,
            name: "SupaCloud",
            slug: "supacloud",
            billing_email: "admin@supacloud.local",
            plan: "pro",
            created_at: new Date().toISOString(),
        };
    })
    .get("/organizations/:slug/projects", async ({ params, set }) => {
        if (params.slug !== "supacloud" && params.slug !== "default") {
            set.status = 404;
            return { error: "Organization not found" };
        }
        const projects = await projectService.listProjects();
        return projects.map(toPlatformProject);
    })
    .get("/organizations/:slug/members", async ({ params, set }) => {
        if (params.slug !== "supacloud" && params.slug !== "default") {
            set.status = 404;
            return { error: "Organization not found" };
        }
        return [{
            id: 1,
            user_id: "1",
            username: "admin",
            email: "admin@supacloud.local",
            role: "Owner",
            created_at: new Date().toISOString(),
        }];
    })

    // --- Projects ---
    .get("/projects", async () => {
        const projects = await projectService.listProjects();
        return projects.map((p: any) => ({
            ...toPlatformProject(p),
            database: {
                host: p.database?.host || "localhost",
                name: p.database?.name || `supa_${p.ref}`,
                user: p.database?.user || `role_${p.ref}`,
                port: p.database?.port || 5432,
            }
        }));
    })
    .get("/projects/:ref", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            ...toPlatformProject(project),
            connectionString: project.connectionString || "",
            database: {
                host: project.database?.host || "localhost",
                name: project.database?.name || `supa_${project.ref}`,
                user: project.database?.user || `role_${project.ref}`,
                port: project.database?.port || 5432,
            },
            api: { url: project.api?.url || "" },
            studio: { url: project.studio?.url || "" },
        };
    })
    .get("/projects/:ref/config", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            project_id: project.id,
            db_dns_name: project.database?.host || "localhost",
            db_ip: "127.0.0.1",
            db_port: project.database?.port || 5432,
            db_name: project.database?.name || `supa_${project.ref}`,
            db_user: project.database?.user || `role_${project.ref}`,
            db_pass: project.database?.password || "postgres",
            jwt_secret: project.jwt_secret || "",
            service_key: project.service_key || "",
            anon_key: project.anon_key || "",
            api_url: project.api?.url || "",
            api_internal_url: `http://localhost:8000`,
            db_ssl: false,
        };
    })
    .get("/projects/:ref/services", async () => ({
        services: [
            { name: "PostgreSQL", status: "ACTIVE_HEALTHY", version: "15.0" },
            { name: "PostgREST", status: "ACTIVE_HEALTHY", version: "12.0" },
            { name: "GoTrue", status: "ACTIVE_HEALTHY", version: "2.0" },
            { name: "Realtime", status: "ACTIVE_HEALTHY", version: "5.0" },
            { name: "Storage", status: "ACTIVE_HEALTHY", version: "1.0" },
        ],
    }))
    .get("/projects/:ref/api-keys", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [
            { id: 1, name: "anon", api_key: project.anon_key || "anon-key", created_at: project.created_at },
            { id: 2, name: "service_role", api_key: project.service_key || "service-key", created_at: project.created_at },
        ];
    })
    .get("/projects/:ref/database", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            host: project.database?.host || "localhost",
            port: project.database?.port || 5432,
            database: project.database?.name || `supa_${project.ref}`,
            user: project.database?.user || `role_${project.ref}`,
            status: "ACTIVE_HEALTHY",
            version: "15.0",
            ssl: false,
        };
    })
    .get("/projects/:ref/postgrest", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            db_schema: "public",
            db_anon_role: "anon",
            db_user: project.database?.user || `role_${project.ref}`,
            max_rows: 1000,
            enabled: true,
        };
    })
    .get("/projects/:ref/auth/config", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return {
            jwt_expiry: 3600,
            jwt_secret: project.jwt_secret || "",
            site_url: project.api?.url || "",
            enabled: true,
            email_enabled: true,
        };
    })
    .get("/projects/:ref/storage", async () => ({
        enabled: true,
        features: { sizes: true, image_transformation: true },
        buckets: [],
    }))
    .get("/projects/:ref/realtime", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return { enabled: !!project.realtime, endpoints: [] };
    })
    .get("/projects/:ref/settings", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return toPlatformProject(project);
    })
    .get("/projects/:ref/functions", async ({ params }) => {
        // Return empty list instead of 404/500 to satisfy Studio
        return [];
    })
    .get("/projects/:ref/edge-functions", async ({ params }) => {
        return [];
    })
    .get("/projects/:ref/databases", async ({ params }) => {
        const project = await getProjectOrThrow(params.ref);
        return [
            {
                id: 1,
                name: project.database?.name || `supa_${project.ref}`,
                host: project.database?.host || "localhost",
                port: project.database?.port || 5432,
                status: "ACTIVE_HEALTHY"
            }
        ];
    })
    // --- pg-meta Proxy ---
    .all("/pg-meta/:ref/*", async ({ params, request, set }) => {
        const project: any = await getProjectOrThrow(params.ref);
        // Map to the internal pg-meta port for the project. 
        // In this architecture, we assume pg-meta is on a consistent port per tenant or we use a internal gateway.
        // For SupaCloud, if we use elygate, we can proxy to it.
        const path = (params as any)["*"];
        const internalUrl = `http://localhost:8080/${path}`; // Default pg-meta port

        try {
            const resp = await fetch(internalUrl, {
                method: request.method,
                headers: {
                    ...request.headers,
                    "x-connection-encrypted": project.database?.password || "postgres"
                },
                body: request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : undefined
            });
            set.status = resp.status;
            return await resp.json();
        } catch (e) {
            set.status = 502;
            return { error: "Failed to proxy to pg-meta", details: String(e) };
        }
    })
    // --- Analytics / Logs Explorer Simulation ---
    .get("/projects/:ref/analytics/endpoints/logs.all", async ({ params, query }) => {
        // Studio often sends SQL queries to Logflare. We'll ignore the SQL and return our system logs.
        const project = await getProjectOrThrow(params.ref);
        const logs = await projectService.queryLogs(project.ref, "all");

        // Studio expects a specific envelope for analytics endpoints
        return {
            data: logs,
            meta: {
                count: logs.length
            }
        };
    });

// Extra top-level routes for auth
export const studioAuthRoutes = new Elysia({ prefix: "/auth" })
    .get("/session", async () => ({
        access_token: "mock-access-token",
        token_type: "bearer",
        expires_in: 3600,
        user: {
            id: "1",
            email: "admin@supacloud.local",
            aud: "authenticated",
            role: "authenticated",
        },
    }))
    .get("/user", async () => ({
        id: "1",
        email: "admin@supacloud.local",
        aud: "authenticated",
        role: "authenticated",
    }));
