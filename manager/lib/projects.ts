
import { join } from "node:path";
import { deps, exists, validateProjectName } from "./deps";
import { BASE_DIR, INSTANCES_DIR } from "./config";
import jwt from "jsonwebtoken";

// Database operations
export async function createDatabase(dbName: string, dbUser: string, dbPass: string) {
    console.log(`Creating database: ${dbName} with user: ${dbUser}`);
    try {
        // 1. Check if DB exists
        const check = await deps.$`docker exec supabase-db psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.text();
        if (check.trim() === "1") {
            console.log(`Database ${dbName} already exists.`);
            return;
        }

        // 2. Create User
        // Check if user exists first to avoid error
        const userCheck = await deps.$`docker exec supabase-db psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'"`.text();
        if (userCheck.trim() !== "1") {
            await deps.$`docker exec supabase-db psql -U postgres -c "CREATE USER ${dbUser} WITH PASSWORD '${dbPass}';"`;
            // Apply Resource Limits (Prevent noisy neighbors)
            await deps.$`docker exec supabase-db psql -U postgres -c "ALTER USER ${dbUser} SET statement_timeout = '60s';"`;
            await deps.$`docker exec supabase-db psql -U postgres -c "ALTER USER ${dbUser} SET connection_limit = 100;"`;
            console.log(`User ${dbUser} created with resource limits.`);
        }

        // 3. Create Database
        await deps.$`docker exec supabase-db psql -U postgres -c "CREATE DATABASE ${dbName} WITH OWNER ${dbUser};"`;
        console.log(`Database ${dbName} created.`);

        // 4. Grant Privileges
        // Grant usage on extensions schema (usually 'extensions' or 'public') to the new user if needed, 
        // but owning the DB is usually enough for the public schema. 
        // We also need to ensure this user can be used by Supabase services (effectively acting as admin for this DB)

        // Grant standard Supabase roles to this user so it can use extensions/features
        await deps.$`docker exec supabase-db psql -U postgres -c "GRANT anon, authenticated, service_role TO ${dbUser};"`;
        // Also grant admin roles from logical replication or storage if needed (optional, but safer to have)
        await deps.$`docker exec supabase-db psql -U postgres -c "GRANT supabase_admin TO ${dbUser};"`;

    } catch (e) {
        console.error("Failed to create DB:", e);
        throw e;
    }
}

// Drop database and user for a project
export async function dropDatabase(dbName: string, dbUser: string) {
    console.log(`Dropping database: ${dbName} and user: ${dbUser}`);
    try {
        // 1. Terminate existing connections
        await deps.$`docker exec supabase-db psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${dbName}' AND pid <> pg_backend_pid();"`;

        // 2. Drop database
        const dbCheck = await deps.$`docker exec supabase-db psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.text();
        if (dbCheck.trim() === "1") {
            await deps.$`docker exec supabase-db psql -U postgres -c "DROP DATABASE ${dbName};"`;
            console.log(`Database ${dbName} dropped.`);
        }

        // 3. Drop user
        const userCheck = await deps.$`docker exec supabase-db psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='${dbUser}'"`.text();
        if (userCheck.trim() === "1") {
            await deps.$`docker exec supabase-db psql -U postgres -c "DROP USER ${dbUser};"`;
            console.log(`User ${dbUser} dropped.`);
        }
    } catch (e) {
        console.error("Failed to drop DB:", e);
        // Don't throw - allow deletion to continue even if DB cleanup fails
    }
}

// Port management - scan existing projects to find used ports and allocate next available
export async function getNextPorts() {
    const usedOffsets = new Set<number>();

    try {
        const glob = new deps.Glob("*/.env");
        for await (const envFile of glob.scan(INSTANCES_DIR)) {
            try {
                const envPath = join(INSTANCES_DIR, envFile);
                const content = await deps.file(envPath).text();
                const kongMatch = content.match(/KONG_HTTP_PORT=(\d+)/);
                if (kongMatch) {
                    const kongPort = parseInt(kongMatch[1], 10);
                    const offset = kongPort - 8000;
                    if (offset > 0) usedOffsets.add(offset);
                }
            } catch {
                // Skip files that can't be read
            }
        }
    } catch (e) {
        console.warn(`Could not scan INSTANCES_DIR: ${e}`);
    }

    // Find first available offset (starting from 10, incrementing by 10)
    let offset = 10;
    while (usedOffsets.has(offset)) {
        offset += 10;
    }

    return { offset };
}

// Project Core Operations
export async function createProject(name: string) {
    // Validate project name
    const validation = validateProjectName(name);
    if (!validation.valid) {
        return { success: false, message: validation.error };
    }

    const projectDir = join(INSTANCES_DIR, name);

    if (await exists(projectDir)) {
        return { success: false, message: "Project already exists" };
    }

    // Ensure instances directory exists
    await deps.mkdir(INSTANCES_DIR, { recursive: true });

    const { offset } = await getNextPorts();
    const kongPort = 8000 + offset;
    const studioPort = 3000 + offset;
    const dbName = `db_${name}`;
    const bucketName = `${name}-storage`;
    const extPort = 9000 + offset;
    const extPortConfig = `\n# Custom Protocol Port (MQTT/TCP/UDP)\nEXT_PORT=${extPort}\n`;

    const dbUser = `owner_${name.replace(/-/g, '_')}`;
    const dbPass = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''); // Long random password

    await createDatabase(dbName, dbUser, dbPass);
    // In the new architecture, we manage per-project databases/users directly in the host database
    // instead of creating project-specific directories with local docker-compose.

    // Provisioning S3 (Simplified for RustFS/MinIO/Global)
    // We utilize the global S3 credentials found in the system.
    // In a future version, we should implement a proper S3 Client to create buckets/users via API.

    let garageAccessKey = "";
    let garageSecretKey = "";

    try {
        console.log(`Configuring S3 for ${name}...`);

        // Try to read RustFS credentials first (Default)
        try {
            const keysContent = await deps.$`cat /etc/rustfs-credentials.env`.text();
            const accessMatch = keysContent.match(/S3_ACCESS_KEY=(.*)/);
            const secretMatch = keysContent.match(/S3_SECRET_KEY=(.*)/);
            if (accessMatch) garageAccessKey = accessMatch[1].trim();
            if (secretMatch) garageSecretKey = secretMatch[1].trim();
        } catch {
            // Fallback to Env vars if passed to Manager
            if (process.env.S3_ACCESS_KEY) garageAccessKey = process.env.S3_ACCESS_KEY;
            if (process.env.S3_SECRET_KEY) garageSecretKey = process.env.S3_SECRET_KEY;
        }

        // If still empty, check for old garage credentials just in case or MinIO
        if (!garageAccessKey) {
            const keysContent = await deps.$`cat /etc/garage/s3-credentials.env`.text();
            const accessMatch = keysContent.match(/S3_ACCESS_KEY=(.*)/);
            const secretMatch = keysContent.match(/S3_SECRET_KEY=(.*)/);
            if (accessMatch) garageAccessKey = accessMatch[1].trim();
            if (secretMatch) garageSecretKey = secretMatch[1].trim();
        }

    } catch (e) {
        console.warn("Could not load S3 credentials:", e);
    }

    if (!garageAccessKey) {
        console.warn("No S3 credentials found. Using placeholders.");
        garageAccessKey = "placeholder";
        garageSecretKey = "placeholder";
    }

    // For RustFS/MinIO, we might need to assume the bucket is created or use a single shared bucket.
    // For now, we point to a project-specific bucket name.
    console.log(`Using S3 Credentials: ${garageAccessKey.substring(0, 5)}...`);

    const j1 = crypto.randomUUID().replace(/-/g, '');
    const j2 = crypto.randomUUID().replace(/-/g, '');
    const jwtSecret = j1 + j2;
    const mcpApiKey = crypto.randomUUID().replace(/-/g, '');

    const anonKey = jwt.sign(
        { role: "anon", iss: "supabase", iat: 1612536800, exp: 1928036800 },
        jwtSecret,
        { algorithm: "HS256" }
    );
    const serviceKey = jwt.sign(
        { role: "service_role", iss: "supabase", iat: 1612536800, exp: 1928036800 },
        jwtSecret,
        { algorithm: "HS256" }
    );

    const enableAnalytics = process.env.ENABLE_ANALYTICS || "postgres";
    const s3StorageType = process.env.S3_STORAGE_TYPE || "rustfs";

    const envContent = `
POSTGRES_DB=${dbName}
POSTGRES_PASSWORD=${dbPass}
POSTGRES_HOST=supabase-db
POSTGRES_PORT=5432
POSTGRES_USER=${dbUser}
KONG_HTTP_PORT=${kongPort}
STUDIO_PORT=${studioPort}
${extPortConfig}
S3_BUCKET=${bucketName}
JWT_SECRET=${jwtSecret}
JWT_EXP=3600
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceKey}
SITE_URL=http://localhost:${studioPort}
S3_ACCESS_KEY=${garageAccessKey}
S3_SECRET_KEY=${garageSecretKey}
S3_STORAGE_TYPE=${s3StorageType}
ENABLE_ANALYTICS=${enableAnalytics}
LOGFLARE_API_KEY=${crypto.randomUUID().replace(/-/g, '')}
EDGE_RUNTIME=deno
FUNCTION_IMAGE=oven/bun:1
FUNCTION_COMMAND=bun run index.ts
MCP_API_KEY=${mcpApiKey}
`;

    // Ensure project directory exists
    await deps.mkdir(projectDir, { recursive: true });

    await deps.write(join(projectDir, ".env"), envContent);

    // In the new Pigsty-centric architecture, we don't copy templates or start local containers.
    // Instead, we just ensure the DB, User, and Ingress are ready.

    console.log(`Project ${name} created in shared infrastructure.`);

    console.log("Configuring Ingress...");
    const rootDomain = process.env.ROOT_DOMAIN || "localhost";
    const caddyFileContent = `
${name}.${rootDomain} {
    reverse_proxy host.docker.internal:${kongPort}
}
mcp.${name}.${rootDomain} {
    reverse_proxy host.docker.internal:3001
}
${name}.studio.${rootDomain} {
    reverse_proxy host.docker.internal:${studioPort}
}
`;
    const caddySitesDir = join(BASE_DIR, "templates", "base", "volumes", "caddy", "sites");
    await deps.mkdir(caddySitesDir, { recursive: true });
    await deps.write(join(caddySitesDir, `${name}.caddy`), caddyFileContent);

    try {
        await deps.$`docker exec supabase-gateway caddy reload --config /etc/caddy/Caddyfile`;
    } catch (e) {
        console.warn("⚠️  Failed to reload Caddy:", e);
    }

    return { success: true, port: studioPort, name, url: `http://${name}.${rootDomain}` };
}

export async function deleteProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    if (!(await exists(projectDir))) return { success: false, message: "Project not found" };

    console.log(`Deleting project ${name}...`);
    try {
        // Clean up database and user
        const dbName = `db_${name}`;
        const dbUser = `owner_${name.replace(/-/g, '_')}`;
        await dropDatabase(dbName, dbUser);

        // Remove files
        await deps.rm(projectDir, { recursive: true, force: true });

        // Remove Caddy config
        const caddyFile = join(BASE_DIR, "templates", "base", "volumes", "caddy", "sites", `${name}.caddy`);
        await deps.$`rm -f ${caddyFile}`;
        await deps.$`docker exec supabase-gateway caddy reload --config /etc/caddy/Caddyfile`;

        return { success: true };
    } catch (e) {
        console.error(e);
        return { success: false, message: String(e) };
    }
}

export async function startProject(name: string) {
    console.log(`Starting project ${name} (logical)`);
    return { success: true };
}

export async function stopProject(name: string) {
    console.log(`Stopping project ${name} (logical)`);
    return { success: true };
}

export async function restartProject(name: string) {
    console.log(`Restarting project ${name} (logical)`);
    return { success: true };
}

// Config & Functions Management
export async function getProjectConfig(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    try {
        const envPath = join(projectDir, ".env");
        if (!(await exists(envPath))) return { success: false, message: "Config not found" };
        const content = await deps.file(envPath).text();
        return { success: true, config: content };
    } catch (e) {
        return { success: false, message: String(e) };
    }
}

export async function updateProjectConfig(name: string, content: string) {
    const projectDir = join(INSTANCES_DIR, name);
    try {
        const envPath = join(projectDir, ".env");
        await deps.write(envPath, content);
        return { success: true };
    } catch (e) {
        return { success: false, message: String(e) };
    }
}

export async function ensureFunctionsDir(name: string) {
    const dir = join(INSTANCES_DIR, name, 'packages', 'bun-auth', 'functions');
    if (!(await exists(dir))) {
        await deps.mkdir(dir, { recursive: true });
    }
    return dir;
}

export async function listFunctions(name: string) {
    try {
        const dir = await ensureFunctionsDir(name);
        const files = await deps.readdir(dir);
        return { success: true, files: files.filter(f => f.endsWith('.ts') || f.endsWith('.js')) };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

export async function getFunction(name: string, filename: string) {
    try {
        const dir = await ensureFunctionsDir(name);
        const path = join(dir, filename);
        const file = deps.file(path);
        if (!(await file.exists())) return { success: false, message: "File not found" };
        return { success: true, code: await file.text() };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

export async function saveFunction(name: string, filename: string, content: string) {
    try {
        const dir = await ensureFunctionsDir(name);
        await deps.write(join(dir, filename), content);
        return { success: true };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

export async function deleteFunction(name: string, filename: string) {
    try {
        const dir = await ensureFunctionsDir(name);
        await deps.rm(join(dir, filename));
        return { success: true };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

export async function getProjectRuntime(name: string) {
    const config = await getProjectConfig(name);
    if (!config.success || !config.config) return "deno";
    const match = config.config.match(/EDGE_RUNTIME=(.*)/);
    return match ? match[1].trim() : "deno";
}

export async function setProjectRuntime(name: string, runtime: "bun" | "deno") {
    const projectDir = join(INSTANCES_DIR, name);
    const configRes = await getProjectConfig(name);
    if (!configRes.success || !configRes.config) {
        return { success: false, message: "Project config not found" };
    }

    let content = configRes.config;
    if (content.includes("EDGE_RUNTIME=")) {
        content = content.replace(/EDGE_RUNTIME=.*/, `EDGE_RUNTIME=${runtime}`);
    } else {
        content += `\nEDGE_RUNTIME=${runtime}\n`;
    }

    await updateProjectConfig(name, content);

    // No longer restarting containers via Docker Compose.
    // The Manager handles runtime logic via shared profiles or labels in the future.
    return { success: true };
}

