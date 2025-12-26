
import { serve, file as bunFile, write as bunWrite, spawn as bunSpawn, Glob as BunGlob } from "bun";
import { readdir, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
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

// Determine BASE_DIR with Priority:
// 1. Env Var: SUPACLOUD_HOME
// 2. Config File: ~/.supacloudrc
// 3. Fallback: Relative to script/binary
const RC_FILE = join(homedir(), ".supacloudrc");
let BASE_DIR = join(import.meta.dir, "..");

// Try to load config synchronously for init
try {
    if (process.env.SUPACLOUD_HOME) {
        BASE_DIR = process.env.SUPACLOUD_HOME;
    } else {
        const rcFile = bunFile(RC_FILE);
        if (await rcFile.exists()) {
            const content = await rcFile.text();
            const match = content.match(/SUPACLOUD_HOME=(.*)/);
            if (match && match[1]) {
                BASE_DIR = match[1].trim();
            }
        }
    }
} catch (e) { }

const INSTANCES_DIR = join(BASE_DIR, "instances");
const TEMPLATE_DIR = join(BASE_DIR, "templates", "project");
const BASE_COMPOSE = join(BASE_DIR, "base", "docker-compose.yml");

// Global Command Variable
let COMPOSE_CMD = ["docker", "compose"];

// Global Auth
let ADMIN_PASSWORD = "";
const AUTH_FILE = join(BASE_DIR, ".manager_auth");

// Helper to check if file exists
async function exists(path: string) {
    const file = deps.file(path);
    return await file.exists();
}


// Database helper using the Global Postgres
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
        console.log(`Database ${dbName} created.`);
    } catch (e) {
        console.error("Failed to create DB:", e);
        throw e;
    }
}

async function getNextPorts() {
    // Optimized: Use Bun.Glob for directory listing
    const glob = new deps.Glob("*");
    let projectCount = 0;
    try {
        for await (const file of glob.scan(INSTANCES_DIR)) {
            const fullPath = join(INSTANCES_DIR, file);
            const stat = await deps.file(fullPath).exists();
            if (stat) {
                projectCount++;
            }
        }
    } catch (e) {
        console.warn(`Could not scan INSTANCES_DIR: ${e}`);
        projectCount = 0;
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

    // Generic Extension Port for custom protocols (MQTT, gRPC, TCP, UDP, etc)
    const extPort = 9000 + offset;
    const extPortConfig = `\n# Custom Protocol Port (MQTT/TCP/UDP)\nEXT_PORT=${extPort}\n`;

    // 2. Create DB
    await createDatabase(dbName);

    // 3. Copy Template
    await deps.$`cp -r ${TEMPLATE_DIR} ${projectDir}`;

    // 4. Provision Garage Bucket & Key (Automated)
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
            console.log(`Garage provisioned: ${garageAccessKey}`);
        } else {
            throw new Error("Could not parse Garage key info");
        }

    } catch (e) {
        console.error("Failed to provision Garage:", e);
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
        console.warn("WARNING: No Garage keys found. S3 storage will fail.");
        garageAccessKey = "placeholder";
        garageSecretKey = "placeholder";
    }

    // Generate simple random secrets for JWTs
    const j1 = crypto.randomUUID().replace(/-/g, '');
    const j2 = crypto.randomUUID().replace(/-/g, '');
    const jwtSecret = j1 + j2;

    const mcpApiKey = crypto.randomUUID().replace(/-/g, '');

    const anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNjEyNTM2ODAwLCJleHAiOjE5MjgwMzY4MDB9.SIGNATURE_PLACEHOLDER";
    const serviceKey = "[REDACTED_SUPABASE_SERVICE_KEY]";

    const envContent = `
POSTGRES_DB=${dbName}
POSTGRES_PASSWORD=your-super-secret-and-long-postgres-password
# Connect to Global DB via Docker Network Alias
POSTGRES_HOST=supabase-db
POSTGRES_PORT=5432

KONG_HTTP_PORT=${kongPort}
STUDIO_PORT=${studioPort}
${extPortConfig}

S3_BUCKET=${bucketName}

# Auth
JWT_SECRET=${jwtSecret}
JWT_EXP=3600
ANON_KEY=${anonKey}
SERVICE_ROLE_KEY=${serviceKey}
SITE_URL=http://localhost:${studioPort}

# Garage Keys (Automated Per-Project)
GARAGE_ACCESS_KEY=${garageAccessKey}
GARAGE_SECRET_KEY=${garageSecretKey}


# WeChat MiniApp (Optional - Fill if needed)
WECHAT_MINIAPP_APPID=
WECHAT_MINIAPP_SECRET=

# Cloud Function Runtime
# Options: bun (default), deno
FUNCTION_IMAGE=oven/bun:1
FUNCTION_COMMAND=bun run index.ts

# For Deno Mode:
# FUNCTION_IMAGE=denoland/deno:2.1.4
# FUNCTION_IMAGE=denoland/deno:2.1.4
# FUNCTION_COMMAND=deno run -A index.deno.ts

# MCP Server
MCP_API_KEY=${mcpApiKey}
  `;

    await deps.write(join(projectDir, ".env"), envContent);

    // 5. Start Project
    console.log(`Starting project ${name} on ports: API=${kongPort}, Studio=${studioPort}`);
    const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "up", "-d"], {
        cwd: projectDir,
    });
    await proc.exited;

    // 6. Caddy Ingress
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
    // Base Caddy Sites Dir
    const caddySitesDir = join(BASE_DIR, "base", "volumes", "caddy", "sites");
    await deps.mkdir(caddySitesDir, { recursive: true });
    await deps.write(join(caddySitesDir, `${name}.caddy`), caddyFileContent);

    // Reload Caddy
    try {
        await deps.$`docker exec supabase-gateway caddy reload --config /etc/caddy/Caddyfile`;
        console.log(`✅ Ingress configured: http://${name}.${rootDomain}`);
    } catch (e) {
        console.warn("⚠️  Failed to reload Caddy (is Base running?):", e);
    }

    return { success: true, port: studioPort, name, url: `http://${name}.${rootDomain}` };
}


// Web Server Handler
export const handler = async (req: Request) => {
    // Auth Check
    const authHeader = req.headers.get("Authorization");
    const expected = `Basic ${btoa(`admin:${ADMIN_PASSWORD}`)}`;

    const url = new URL(req.url);

    // Allow Health Check without auth
    if (url.pathname !== "/health") {
        if (!authHeader || authHeader !== expected) {
            return new Response("Unauthorized", {
                status: 401,
                headers: { "WWW-Authenticate": 'Basic realm="SupaCloud Manager"' }
            });
        }
    }

    if (url.pathname === "/" && req.method === "GET") {
        // List Projects
        const projects = await deps.readdir(INSTANCES_DIR).catch(() => []);
        const listHtml = projects.map(p => `<li>${p} <button onclick="deleteProject('${p}')">Delete</button></li>`).join("");

        const credentials = btoa(`admin:${ADMIN_PASSWORD}`);

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
                const res = await fetch('/projects', { 
                    method: 'POST', 
                    body: JSON.stringify({name}),
                    headers: { 'Authorization': 'Basic ${credentials}' }
                });
                if (res.ok) location.reload();
                else alert('Failed');
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

// 7. Check and Auto-Install Docker Compose
async function checkAndInstallDockerCompose() {
    console.log("Manager: Checking Docker Compose...");

    try {
        const p = deps.spawn(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" });
        if ((await p.exited) === 0) {
            console.log("✅ Using 'docker compose'");
            COMPOSE_CMD = ["docker", "compose"];
            return;
        }
    } catch { }

    try {
        const p = deps.spawn(["docker-compose", "version"], { stdout: "ignore", stderr: "ignore" });
        if ((await p.exited) === 0) {
            console.log("✅ Using 'docker-compose' (System)");
            COMPOSE_CMD = ["docker-compose"];
            return;
        }
    } catch { }

    const binDir = join(BASE_DIR, "bin");
    const localBin = join(binDir, "docker-compose");

    if (await exists(localBin)) {
        console.log("✅ Using local 'bin/docker-compose'");
        COMPOSE_CMD = [localBin];
        return;
    }

    console.log("⚠️  Docker Compose not found. Auto-installing...");
    await deps.mkdir(binDir, { recursive: true });

    try {
        const kernel = (await deps.$`uname -s`.text()).trim();
        const arch = (await deps.$`uname -m`.text()).trim();
        const url = `https://ghproxy.net/github.com/docker/compose/releases/download/v2.40.3/docker-compose-${kernel}-${arch}`;

        console.log(`Downloading from: ${url}`);
        await deps.$`curl -L "${url}" -o "${localBin}"`;
        await deps.$`chmod +x "${localBin}"`;

        console.log("✅ Docker Compose installed to bin/docker-compose");
        COMPOSE_CMD = [localBin];
    } catch (e) {
        console.error("❌ Failed to install Docker Compose:", e);
        console.warn("Please install docker-compose manually.");
    }
}

// 6. Auto-Initialize Manager (Zero Config & Auth)
async function initManager() {
    // 1. Garage Config
    const configDir = join(BASE_DIR, "base", "volumes", "garage", "config");
    const configPath = join(configDir, "garage.toml");

    if (!(await exists(configPath))) {
        console.log("Manager: No garage.toml found. Auto-initializing...");

        await deps.mkdir(configDir, { recursive: true });

        const rpcSecret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        const adminToken = crypto.randomUUID().replace(/-/g, '');

        const tomlContent = `
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_mode = "none"

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"
rpc_secret = "${rpcSecret}"

[s3_api]
s3_region = "us-east-1"
api_bind_addr = "[::]:3900"
root_domain = ".s3.localhost"

[s3_web]
bind_addr = "[::]:3902"
root_domain = ".web.localhost"
index = "index.html"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "${adminToken}"
`;

        await deps.write(configPath, tomlContent);
        console.log("✅ Manager: Generated garage.toml with secure secrets.");
        console.log(`   RPC Secret: ${rpcSecret.substring(0, 8)}...`);
        console.log(`   Admin Token: ${adminToken}`);
        console.log("⚠️  IMPORTANT: Please restart your Base services (docker compose restart garage) to apply these changes!");
    } else {
        console.log("Manager: Found existing garage.toml, skipping auto-init.");
    }

    // 2. Manager Auth
    if (await exists(AUTH_FILE)) {
        ADMIN_PASSWORD = (await deps.file(AUTH_FILE).text()).trim();
        console.log("🔒 Manager Auth: Loaded password from file.");
    } else {
        console.log("\n🔐 Setting up Manager Authentication");
        let password = "";

        if (process.env.ADMIN_PASSWORD) {
            password = process.env.ADMIN_PASSWORD;
        } else {
            password = crypto.randomUUID().substring(0, 8);
            console.log(`⚠️  Generated temporary admin password: ${password}`);
            console.log(`   (You can change this by editing ${AUTH_FILE})`);
        }

        await deps.write(AUTH_FILE, password);
        ADMIN_PASSWORD = password;
    }
}

// New Helper: Start Base
async function startBase() {
    console.log("Starting Base Platform (Postgres, Garage, Caddy, Backup)...");
    const proc = deps.spawn([...COMPOSE_CMD, "up", "-d"], {
        cwd: join(BASE_DIR, "base"),
        stdio: ["inherit", "inherit", "inherit"]
    });
    await proc.exited;
}

// New Helper: Status
async function showStatus() {
    console.log("--- SupaCloud Status ---");
    // Show Base Status
    const baseProc = deps.spawn([...COMPOSE_CMD, "ps"], { cwd: join(BASE_DIR, "base"), stdio: ["inherit", "inherit", "inherit"] });
    await baseProc.exited;

    console.log("\n--- Projects ---");
    // List projects (directories in instances)
    const projects = await deps.readdir(INSTANCES_DIR).catch(() => []);
    if (projects.length === 0) {
        console.log("No projects found.");
    } else {
        for (const p of projects) {
            console.log(`- ${p} (http://${p}.localhost)`);
        }
    }

    console.log("\n--- Access Points ---");
    console.log(`Manager: http://localhost:8888`);
    console.log(`Logs:    http://logs.localhost`);
}

// New Helper: Install
async function installCLI() {
    console.log("Installing SupaCloud CLI...");

    // Determine the actual root of the SupaCloud repo/installation
    // If running compiled binary: process.execPath is '.../bin/supacloud.exe'
    // If running script: process.cwd() or import.meta.dir

    // Heuristic: If we are running 'install', we assume the current binary/script is in the correct workspace.
    // import.meta.dir in compiled binary points to the folder containing the binary.
    const currentRoot = join(import.meta.dir, "..");

    console.log(`\n1. Configuring Workspace Root: ${currentRoot}`);
    try {
        await deps.write(RC_FILE, `SUPACLOUD_HOME=${currentRoot}`);
        console.log(`   ✅ Saved to ${RC_FILE}`);
    } catch (e) {
        console.error(`   ❌ Failed to write config:`, e);
    }

    const binDir = join(currentRoot, "bin");
    const isWindows = process.platform === "win32";

    console.log(`\n2. System PATH Configuration`);
    if (isWindows) {
        console.log(`   Please add the following folder to your User PATH environment variable:`);
        console.log(`\n   ${binDir}\n`);
        console.log(`   Command to verify installation:`);
        console.log(`   supacloud status`);

        // Optional: Attempt PowerShell magic
        try {
            console.log("   Attempting to add to PATH via PowerShell...");
            const setPathScript = `
                $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
                if ($currentPath -notlike "*${binDir}*") {
                    [Environment]::SetEnvironmentVariable("Path", "$currentPath;${binDir}", "User")
                    Write-Output "SUCCESS"
                } else {
                    Write-Output "EXISTS"
                }
            `;
            const proc = deps.spawn(["powershell", "-Command", setPathScript], { stdout: "pipe" });
            const output = await new Response(proc.stdout).text();

            if (output.includes("SUCCESS")) {
                console.log("   ✅ Successfully added to User PATH.");
                console.log("   ⚠️  Restart your terminal to use 'supacloud' command.");
            } else if (output.includes("EXISTS")) {
                console.log("   ✅ Already in PATH.");
            }
        } catch (e) { }

    } else {
        // Linux/Mac
        const target = "/usr/local/bin/supacloud";
        const src = join(binDir, "supacloud");

        try {
            // Check if we have sudo access or write access
            await deps.$`ln -sf ${src} ${target}`;
            console.log(`   ✅ Created symlink: ${target} -> ${src}`);
        } catch (e) {
            console.log(`   ❌ Failed to create symlink (Permission denied).`);
            console.log(`   Please run the following command manually:`);
            console.log(`\n   sudo ln -sf ${src} ${target}\n`);
        }
    }
}

// Export functions for testing
export { createProject, getNextPorts, exists, createDatabase, initManager };

// New Helper: Init
async function initProject(targetDir?: string) {
    const dir = targetDir || ".";
    const fullPath = join(process.cwd(), dir);

    console.log(`Initializing SupaCloud in ${fullPath}...`);

    if (await exists(join(fullPath, "base", "docker-compose.yml"))) {
        console.log("⚠️  SupaCloud already initialized in this directory.");
        return;
    }

    await deps.mkdir(fullPath, { recursive: true });

    try {
        // Download main branch zip
        const url = "https://github.com/zuohuadong/supacloud/archive/refs/heads/main.zip";
        const proxyUrl = `https://ghproxy.net/${url}`;

        console.log(`Downloading source from ${proxyUrl}...`);

        const zipPath = join(fullPath, "supacloud.zip");
        await deps.$`curl -L "${proxyUrl}" -o "${zipPath}"`;

        console.log("Extracting...");
        // Use bun to unzip if possible, or unzip command
        // Simple unzip via shell
        await deps.$`unzip -q -o "${zipPath}" -d "${fullPath}"`;

        // Move contents from supacloud-main to root
        const extractedDir = join(fullPath, "supacloud-main");
        await deps.$`cp -r ${extractedDir}/* ${fullPath}/`;
        await deps.$`rm -rf ${extractedDir} ${zipPath}`;

        // Set SUPACLOUD_HOME
        await deps.write(RC_FILE, `SUPACLOUD_HOME=${fullPath}`);

        console.log("✅ Initialization complete!");
        console.log(`\nRun 'supacloud start' to launch the platform.`);

    } catch (e) {
        console.error("❌ Failed to initialize:", e);
    }
}

// 8. Runtime Switcher (Bun <-> Deno)
async function switchRuntime(name: string, runtime: string) {
    const projectDir = join(INSTANCES_DIR, name);
    if (!(await exists(projectDir))) {
        console.log(`❌ Project '${name}' not found in ${INSTANCES_DIR}`);
        return;
    }

    if (runtime !== "bun" && runtime !== "deno") {
        console.log("❌ Invalid runtime. Allowed: 'bun', 'deno'");
        return;
    }

    console.log(`Switching ${name} to ${runtime} runtime...`);

    const envPath = join(projectDir, ".env");
    let envContent = await deps.file(envPath).text();

    let image = "";
    let command = "";

    if (runtime === "bun") {
        image = "oven/bun:1";
        command = "bun run index.ts";
    } else {
        image = "denoland/deno:2.1.4";
        command = "deno run -A index.deno.ts";
    }

    const replaceOrAppend = (text: string, key: string, value: string) => {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(text)) {
            return text.replace(regex, `${key}=${value}`);
        } else {
            return text + `\n${key}=${value}`;
        }
    };

    envContent = replaceOrAppend(envContent, "FUNCTION_IMAGE", image);
    envContent = replaceOrAppend(envContent, "FUNCTION_COMMAND", command);

    await deps.write(envPath, envContent);
    console.log("✅ Updated .env configuration.");

    // Restart the service
    console.log("🔄 Restarting bun-auth service...");
    try {
        const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "up", "-d", "--force-recreate", "bun-auth"], {
            cwd: projectDir,
            stdio: ["ignore", "inherit", "inherit"]
        });
        await proc.exited;
        console.log(`✅ Successfully switched ${name} to ${runtime}!`);
    } catch (e) {
        console.error("❌ Failed to restart service:", e);
    }
}

// Main CLI Entry
if (import.meta.main) {
    // Heuristic for Bun compiled vs Interpreted
    const isCompiled = !process.argv[0].endsWith("bun") && !process.argv[0].endsWith("bun.exe");
    const argOffset = isCompiled ? 1 : 2;
    const command = process.argv[argOffset] || "help";
    const cmdArgs = process.argv.slice(argOffset + 1);

    // Commands that don't require initialization
    if (command === "init") {
        await initProject(cmdArgs[0]);
        process.exit(0);
    }

    if (command === "help" || command === "--help" || command === "-h") {
        console.log("Usage: supacloud <command>");
        console.log("Commands:");
        console.log("  init [dir]    Initialize a new SupaCloud workspace");
        console.log("  start         Start the SupaCloud platform (Base + Manager)");
        console.log("  create <name> Create a new Supabase project");
        console.log("  runtime <name> <bun|deno>  Switch project runtime");
        console.log("  status        Show platform status and projects");
        console.log("  install       Install CLI to system (PATH)");
        console.log("  help          Show this help message");
        process.exit(0);
    }

    // Initialize Manager for other commands
    await initManager();
    await checkAndInstallDockerCompose();

    switch (command) {
        case "start":
            await startBase();
            console.log("Starting Manager API...");
            const server = deps.serve({
                port: 8888,
                fetch: handler,
            });
            console.log(`Manager listening on http://localhost:${server.port}`);
            break;

        case "create":
            const name = cmdArgs[0];
            if (!name) {
                console.error("Usage: supacloud create <name>");
                process.exit(1);
            }
            const res = await createProject(name);
            if (res.success) {
                console.log(`\nProject '${name}' created successfully!`);
                console.log(`Studio: http://${name}.studio.localhost`);
                console.log(`API:    http://${name}.localhost`);
            } else {
                console.error(`Failed: ${res.message}`);
            }
            process.exit(0);
            break;

        case "runtime":
        case "set-runtime":
            const projName = cmdArgs[0];
            const mode = cmdArgs[1];
            if (!projName || !mode) {
                console.error("Usage: supacloud runtime <project_name> <bun|deno>");
                process.exit(1);
            }
            await switchRuntime(projName, mode);
            process.exit(0);
            break;

        case "status":
            await showStatus();
            process.exit(0);
            break;

        case "install":
            await installCLI();
            process.exit(0);
            break;

        default:
            console.log(`Unknown command: ${command}`);
            console.log("Run 'supacloud help' for usage.");
            process.exit(1);
    }
}
