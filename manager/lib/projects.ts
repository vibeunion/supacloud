
import { join } from "node:path";
import { deps, exists } from "./deps";
import { BASE_DIR, INSTANCES_DIR, TEMPLATE_DIR, COMPOSE_CMD } from "./config";

// Database operations
export async function createDatabase(dbName: string) {
    console.log(`Creating database: ${dbName}`);
    try {
        const check = await deps.$`docker exec supabase-db psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.text();
        if (check.trim() === "1") {
            console.log(`Database ${dbName} already exists.`);
            return;
        }
        await deps.$`docker exec supabase-db psql -U postgres -c "CREATE DATABASE ${dbName};"`;
        console.log(`Database ${dbName} created.`);
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

    await createDatabase(dbName);
    await deps.$`cp -r ${TEMPLATE_DIR} ${projectDir}`;

    let garageAccessKey = "";
    let garageSecretKey = "";

    try {
        console.log(`Provisioning Garage S3 for ${name}...`);
        try { await deps.$`docker exec garage garage bucket create ${bucketName}`; } catch { }
        try { await deps.$`docker exec garage garage garage key create ${name}`; } catch { }
        await deps.$`docker exec garage garage garage bucket allow ${bucketName} --read --write --key ${name}`;

        const keyInfo = await deps.$`docker exec garage garage garage key info ${name}`.text();
        const accessMatch = keyInfo.match(/Key ID:\s+(GK[a-f0-9]+)/i);
        const secretMatch = keyInfo.match(/Secret key:\s+([a-f0-9]+)/i);

        if (accessMatch && secretMatch) {
            garageAccessKey = accessMatch[1];
            garageSecretKey = secretMatch[1];
        } else {
            throw new Error("Could not parse Garage key info");
        }

    } catch (e) {
        console.warn("Falling back to global keys check...");
        try {
            const keysPath = join(BASE_DIR, "base", "volumes", "garage", "config", "garage_keys.env");
            const keysContent = await deps.file(keysPath).text();
            const accessMatch = keysContent.match(/GARAGE_ACCESS_KEY=(.*)/);
            const secretMatch = keysContent.match(/GARAGE_SECRET_KEY=(.*)/);
            if (accessMatch) garageAccessKey = accessMatch[1].trim();
            if (secretMatch) garageSecretKey = secretMatch[1].trim();
        } catch { }
    }

    if (!garageAccessKey) {
        garageAccessKey = "placeholder";
        garageSecretKey = "placeholder";
    }

    const j1 = crypto.randomUUID().replace(/-/g, '');
    const j2 = crypto.randomUUID().replace(/-/g, '');
    const jwtSecret = j1 + j2;
    const mcpApiKey = crypto.randomUUID().replace(/-/g, '');
    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNjEyNTM2ODAwLCJleHAiOjE5MjgwMzY4MDB9.SIGNATURE_PLACEHOLDER";
    const serviceKey = "[REDACTED_SUPABASE_SERVICE_KEY]";

    const envContent = `
POSTGRES_DB=${dbName}
POSTGRES_PASSWORD=your-super-secret-and-long-postgres-password
POSTGRES_HOST=supabase-db
POSTGRES_PORT=5432
KONG_HTTP_PORT=${kongPort}
STUDIO_PORT=${studioPort}
${extPortConfig}
S3_BUCKET=${bucketName}
JWT_SECRET=${jwtSecret}
JWT_EXP=3600
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceKey}
SITE_URL=http://localhost:${studioPort}
GARAGE_ACCESS_KEY=${garageAccessKey}
GARAGE_SECRET_KEY=${garageSecretKey}
WECHAT_MINIAPP_APPID=
WECHAT_MINIAPP_SECRET=
FUNCTION_IMAGE=oven/bun:1
FUNCTION_COMMAND=bun run index.ts
MCP_API_KEY=${mcpApiKey}
`;

    await deps.write(join(projectDir, ".env"), envContent);

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
    const caddySitesDir = join(BASE_DIR, "base", "volumes", "caddy", "sites");
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
        const caddyFile = join(BASE_DIR, "base", "volumes", "caddy", "sites", `${name}.caddy`);
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
