
import { serve, file as bunFile, write as bunWrite, spawn as bunSpawn, Glob as BunGlob } from "bun";
import { readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

// Export dependencies for mocking
export const deps = {
    $,
    serve,
    file: bunFile,
    write: bunWrite,
    spawn: bunSpawn,
    Glob: BunGlob,
    readdir,
    mkdir
};

const BASE_DIR = join(import.meta.dir, "..");
const INSTANCES_DIR = join(BASE_DIR, "instances");
const TEMPLATE_DIR = join(BASE_DIR, "templates", "project");
const BASE_COMPOSE = join(BASE_DIR, "base", "docker-compose.yml");

// Helper to check if file exists
async function exists(path: string) {
    const file = deps.file(path);
    return await file.exists();
}


// Database helper using the Global Postgres
// We'll use psql via docker exec because we don't want to install pg driver just for this script if possible,
// but for robustness in Bun we should probably use 'postgres' package.
// For MVP, lets use docker cli.
async function createDatabase(dbName: string) {
    console.log(`Creating database: ${dbName}`);
    try {
        // Check if db exists
        const check = await deps.$`docker exec supabase-db psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`.text();
        if (check.trim() === "1") {
            console.log(`Database ${dbName} already exists.`);
            return;
        }

        // Create DB
        await deps.$`docker exec supabase-db psql -U postgres -c "CREATE DATABASE ${dbName};"`;
        // Grant permissions (simplified for now, usually need a specific user)
        // await $`docker exec supabase-db psql -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO postgres;"`; 
        console.log(`Database ${dbName} created.`);
    } catch (e) {
        console.error("Failed to create DB:", e);
        throw e;
    }
}

async function getNextPorts() {
    // Simple heuristic: read all existing projects and find max port
    // Base ports: Kong 8000, Studio 3000. 
    // We will offset by 10 for each project: 
    // Project 1: Kong 8010, Studio 3010
    // Project 2: Kong 8020, Studio 3020

    // Optimized: Use Bun.Glob for directory listing
    const glob = new deps.Glob("*");
    let projectCount = 0;
    try {
        for await (const file of glob.scan(INSTANCES_DIR)) {
            // Only count directories, assuming project instances are directories
            const fullPath = join(INSTANCES_DIR, file);
            const stat = await deps.file(fullPath).exists(); // Check if it's a file/dir
            if (stat) { // If it exists, it's a project directory
                projectCount++;
            }
        }
    } catch (e) {
        // INSTANCES_DIR might not exist yet, or other errors
        console.warn(`Could not scan INSTANCES_DIR: ${e}`);
        projectCount = 0; // Default to 0 if scan fails
    }

    return {
        offset: (projectCount + 1) * 10
    };
}

async function createProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);

    if (await exists(projectDir)) {
        return { success: false, message: "Project already exists" };
    }

    // 1. Calculate Ports & Config
    const { offset } = await getNextPorts();
    const kongPort = 8000 + offset;
    const studioPort = 3000 + offset;
    const dbName = `db_${name}`;
    const bucketName = `${name}-storage`;

    // 2. Create DB
    await createDatabase(dbName);

    // 3. Copy Template
    await deps.$`cp -r ${TEMPLATE_DIR} ${projectDir}`;

    // 4. Generate .env
    // We need to read the global .env to get passwords, or just hardcode for MVP if they are fixed in base.
    // Assuming keys are passed via env vars or read from a global config.
    // For this MVP, we generate a fresh .env for the project

    // 4. Provision Garage Bucket & Key (Automated)
    let garageAccessKey = "";
    let garageSecretKey = "";

    try {
        console.log(`Provisioning Garage S3 for ${name}...`);

        // Create Bucket
        // Ignore error if exists (or check first, but create is idempotent-ish or fails safely)
        try { await deps.$`docker exec garage garage bucket create ${bucketName}`; } catch { }

        // Create Key
        // key create returns info including secret. 
        // Format: 
        // Key ID: GK...
        // Secret key: ...
        // Name: ...
        // Can also use --json if available, or parse text. v0.9 might not have --json for all cmds.
        // Let's try to just create and then 'key info' with grep?
        // Actually 'key create' might fail if exists.
        try { await deps.$`docker exec garage garage garage key create ${name}`; } catch { }

        // Bind Key to Bucket
        await deps.$`docker exec garage garage garage bucket allow ${bucketName} --read --write --key ${name}`;

        // Retrieve Keys
        // key info ${name} shows keys.
        const keyInfo = await deps.$`docker exec garage garage garage key info ${name}`.text();

        // Parse Key ID and Secret
        // Example output v0.9:
        // Key ID: GKxxxx
        // Secret key: xxxxx
        const accessMatch = keyInfo.match(/Key ID:\s+(GK[a-f0-9]+)/i);
        const secretMatch = keyInfo.match(/Secret key:\s+([a-f0-9]+)/i);

        if (accessMatch && secretMatch) {
            garageAccessKey = accessMatch[1];
            garageSecretKey = secretMatch[1];
            console.log(`Garage provisioned: ${garageAccessKey}`);
        } else {
            throw new Error("Could not parse Garage key info");
        }

    } catch (e) {
        console.error("Failed to provision Garage:", e);
        console.warn("Falling back to global keys check...");
        // Fallback Code (Original logic)
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
        console.warn("WARNING: No Garage keys found. S3 storage will fail.");
        garageAccessKey = "placeholder";
        garageSecretKey = "placeholder";
    }

    // Generate simple random secrets for JWTs
    const j1 = crypto.randomUUID().replace(/-/g, '');
    const j2 = crypto.randomUUID().replace(/-/g, '');
    const jwtSecret = j1 + j2;

    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNjEyNTM2ODAwLCJleHAiOjE5MjgwMzY4MDB9.SIGNATURE_PLACEHOLDER";
    const serviceKey = "[REDACTED_SUPABASE_SERVICE_KEY]";

    // TODO: Use actual JWT signing if possible.

    const envContent = `
POSTGRES_DB=${dbName}
POSTGRES_PASSWORD=your-super-secret-and-long-postgres-password
# Connect to Global DB via Docker Network Alias
POSTGRES_HOST=supabase-db
POSTGRES_PORT=5432

KONG_HTTP_PORT=${kongPort}
STUDIO_PORT=${studioPort}
S3_BUCKET=${bucketName}

# Auth
JWT_SECRET=${jwtSecret}
JWT_EXP=3600
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceKey}
SITE_URL=http://localhost:${studioPort}

# Garage Keys (Automated Per-Project)
# Garage Keys (Automated Per-Project)
GARAGE_ACCESS_KEY=${garageAccessKey}
GARAGE_SECRET_KEY=${garageSecretKey}

# WeChat MiniApp (Optional - Fill if needed)
WECHAT_MINIAPP_APPID=
WECHAT_MINIAPP_SECRET=
  `;

    await deps.write(join(projectDir, ".env"), envContent);

    // 5. Start Project
    // We must include the project's env file
    console.log(`Starting project ${name} on ports: API=${kongPort}, Studio=${studioPort}`);
    const proc = deps.spawn(["docker", "compose", "-p", name, "up", "-d"], {
        cwd: projectDir,
        // env: { ...process.env } // Pass through current env if needed
    });
    await proc.exited;

    return { success: true, port: studioPort, name };
}


// Web Server Handler
export const handler = async (req: Request) => {
    const url = new URL(req.url);

    if (url.pathname === "/" && req.method === "GET") {
        // List Projects
        const projects = await deps.readdir(INSTANCES_DIR).catch(() => []);
        const listHtml = projects.map(p => `<li>${p} <button onclick="deleteProject('${p}')">Delete</button></li>`).join("");

        return new Response(`
        <html>
          <body>
            <h1>Supabase Manager</h1>
            <ul>${listHtml}</ul>
            <hr/>
            <input id="pname" placeholder="Project Name"/>
            <button onclick="create()">Create Project</button>
            <script>
              async function create() {
                const name = document.getElementById('pname').value;
                const res = await fetch('/projects', { method: 'POST', body: JSON.stringify({name}) });
                location.reload();
              }
            </script>
          </body>
        </html>
      `, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/projects" && req.method === "POST") {
        const body = await req.json() as { name: string };
        const res = await createProject(body.name);
        return Response.json(res);
    }

    return new Response("Not Found", { status: 404 });
};

// Export functions for testing
export { createProject, getNextPorts, exists, createDatabase };

// Start Server if main
if (import.meta.main) {
    const server = deps.serve({
        port: 8888,
        fetch: handler,
    });
    console.log(`Manager listening on http://localhost:${server.port}`);
}

