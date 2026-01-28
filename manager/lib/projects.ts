
import { join } from "node:path";
import { deps, exists } from "./deps";
import { BASE_DIR, INSTANCES_DIR, TEMPLATE_DIR, COMPOSE_CMD } from "./config";

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

// Port management
export async function getNextPorts() {
    const glob = new deps.Glob("*");
    let projectCount = 0;
    try {
        for await (const file of glob.scan(INSTANCES_DIR)) {
            const fullPath = join(INSTANCES_DIR, file);
            if (await deps.file(fullPath).exists()) projectCount++;
        }
    } catch (e) {
        console.warn(`Could not scan INSTANCES_DIR: ${e}`);
        projectCount = 0;
    }
    return { offset: (projectCount + 1) * 10 };
}

// Project Core Operations
export async function createProject(name: string) {
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
    await deps.$`cp -r ${TEMPLATE_DIR} ${projectDir}`;

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
    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNjEyNTM2ODAwLCJleHAiOjE5MjgwMzY4MDB9.SIGNATURE_PLACEHOLDER";
    const serviceKey = "[REDACTED_SUPABASE_SERVICE_KEY]";

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

    await deps.write(join(projectDir, ".env"), envContent);

    // Apply Analytics Stripping if needed
    if (enableAnalytics !== "on") {
        console.log(`Optimizing docker-compose for ${name} (Analytics: ${enableAnalytics})...`);
        const composePath = join(projectDir, "docker-compose.yml");
        if (await exists(composePath)) {
            // 1. Remove analytics related services
            await deps.$`sed -i '/analytics:/,/^[a-zA-Z]/ { /analytics:/d; /^[a-zA-Z]/!d }' ${composePath}`;

            if (enableAnalytics === "off") {
                await deps.$`sed -i '/logflare:/,/^[a-zA-Z]/ { /logflare:/d; /^[a-zA-Z]/!d }' ${composePath}`;
                await deps.$`sed -i '/vector:/,/^[a-zA-Z]/ { /vector:/d; /^[a-zA-Z]/!d }' ${composePath}`;
                await deps.$`sed -i '/- logflare/d' ${composePath}`;
            } else if (enableAnalytics === "postgres") {
                // Map Logflare to Postgres (Simplified alignment)
                await deps.$`sed -i 's/LOGFLARE_URL: http:\\/\\/analytics:5432/LOGFLARE_URL: http:\\/\\/supabase-db:5432/g' ${composePath}`;
            }

            // 2. Remove dependencies
            await deps.$`sed -i '/- analytics/d' ${composePath}`;
            await deps.$`sed -i '/analytics: service/d' ${composePath}`;

            // 3. Cleanup empty depends_on
            await deps.$`sed -i '/depends_on:[[:space:]]*$/ { N; /^[[:space:]]*[a-z]/ { s/.*depends_on:[[:space:]]*\\n// } }' ${composePath}`;
        }
    }

    console.log(`Starting project ${name}...`);
    const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "up", "-d"], { cwd: projectDir });
    await proc.exited;

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
        // Stop containers
        // Changed stdio to fix previous TS type error implicitly if used in spawn option
        const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "down", "-v"], {
            cwd: projectDir,
            stdio: ["ignore", "ignore", "ignore"]
        });
        await proc.exited;

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
    const projectDir = join(INSTANCES_DIR, name);
    const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "up", "-d"], { cwd: projectDir });
    const exitCode = await proc.exited;
    return { success: exitCode === 0 };
}

export async function stopProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "stop"], { cwd: projectDir });
    const exitCode = await proc.exited;
    return { success: exitCode === 0 };
}

export async function restartProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "restart"], { cwd: projectDir });
    const exitCode = await proc.exited;
    return { success: exitCode === 0 };
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
    const dir = join(INSTANCES_DIR, name, 'functions');
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

    // Restart with specific profiles
    console.log(`Switching project ${name} to runtime: ${runtime}...`);

    // Stop old runtime containers specifically if needed, 
    // but 'up -d' with changed profiles often handles it.
    // However, to be sure we switch correctly:
    const profiles = runtime === "bun" ? ["bun"] : ["deno"];

    // Using --profile flag with docker compose
    const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "--profile", runtime, "up", "-d", "--remove-orphans"], {
        cwd: projectDir
    });

    const exitCode = await proc.exited;
    return { success: exitCode === 0 };
}

