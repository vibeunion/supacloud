
import { serve, file as bunFile, write as bunWrite, spawn as bunSpawn, Glob as BunGlob } from "bun";
import { readdir, mkdir, rename, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { $ } from "bun";
import { Hono, type Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { serveStatic } from "hono/bun";
import { getCookie, setCookie } from "hono/cookie";
import type { FC } from "hono/jsx";

// Export dependencies for mocking
export const deps = {
    $,
    serve,
    file: bunFile,
    write: bunWrite,
    spawn: bunSpawn,
    Glob: BunGlob,
    readdir,
    mkdir,
    rename,
    rm
};

// --- Configuration & Constants ---
const RC_FILE = join(homedir(), ".supacloudrc");
let BASE_DIR = join(import.meta.dir, "..");

try {
    if (process.env.SUPACLOUD_HOME) {
        BASE_DIR = process.env.SUPACLOUD_HOME;
    } else {
        const rcFile = bunFile(RC_FILE);
        if (await rcFile.exists()) {
            const content = await rcFile.text();
            const match = content.match(/SUPACLOUD_HOME=(.*)/);
            if (match && match[1]) BASE_DIR = match[1].trim();
        }
    }
} catch (e) { }

const INSTANCES_DIR = join(BASE_DIR, "instances");
const TEMPLATE_DIR = join(BASE_DIR, "templates", "project");
const BASE_COMPOSE = join(BASE_DIR, "base", "docker-compose.yml");
let COMPOSE_CMD = ["docker", "compose"];
let ADMIN_PASSWORD = "";
const ROOT_DOMAIN = process.env.ROOT_DOMAIN || "localhost";
const AUTH_FILE = join(BASE_DIR, ".manager_auth");

const DICTIONARY = {
    en: {
        status_label: "System Status",
        status_ok: "Operational",
        projects_title: "Projects",
        btn_new: "New Project",
        btn_restart: "Restart",
        btn_start: "Start",
        btn_stop: "Stop",
        btn_logs: "Logs",
        btn_config: "Config",
        btn_delete: "Delete",
        btn_cancel: "Cancel",
        btn_create: "Create",
        btn_save: "Save Changes",
        modal_create_title: "Create New Project",
        input_name_label: "Project Name",
        input_name_placeholder: "e.g. my-awesome-app",
        input_hint: "Only lowercase letters, numbers, and hyphens.",
        modal_logs_title: "Logs",
        modal_config_title: "Environment Variables",
        hint_restart: "Restart required after saving",
        confirm_delete: "Are you sure you want to delete {name}? This cannot be undone.",
        link_studio: "Studio",
        link_api: "API Endpoint",
        lang_switch: "中文",
        col_name: "Project Name",
        col_status: "Status",
        col_endpoints: "Endpoints",
        col_actions: "Actions",
        btn_code: "Code",
        modal_code_title: "Function Code",
        btn_add_func: "New Function",
        btn_delete_func: "Delete",
        placeholder_func_name: "index.ts",
        title_env_vars: "Environment Variables",
        hint_save_restart: "Save changes and restart service to apply",
        // New features
        section_monitoring: "Monitoring",
        section_system: "System Operations",
        btn_update_check: "Check for Updates",
        btn_update_now: "Update System",
        btn_backup_restore: "Backups & Restore",
        modal_system_update_title: "System Update",
        modal_restore_title: "Data Restore",
        monitor_cpu: "CPU Usage",
        monitor_mem: "Memory Usage",
        monitor_net: "Net I/O",
        table_backup_file: "Backup File",
        table_backup_size: "Size",
        table_backup_date: "Date",
        btn_restore: "Restore",
        confirm_restore: "Are you sure you want to restore {file}? CURRENT DATA WILL BE LOST!",
        update_available: "New version available!",
        update_uptodate: "Your system is up to date.",
        msg_update_started: "Update started. System will restart...",
        msg_checking_update: "Checking for updates...",
        msg_update_found: "New version found: v{version}",
        msg_no_update: "You are on the latest version.",
        btn_skip_update: "Skip"
    },
    zh: {
        status_label: "系统状态",
        status_ok: "运行正常",
        projects_title: "项目管理",
        btn_new: "新建项目",
        btn_restart: "重启服务",
        btn_start: "启动服务",
        btn_stop: "停止服务",
        btn_logs: "查看日志",
        btn_config: "修改配置",
        btn_delete: "删除项目",
        btn_cancel: "取消",
        btn_create: "立即创建",
        btn_save: "保存更改",
        modal_create_title: "创建新项目",
        input_name_label: "项目名称",
        input_name_placeholder: "例如: my-app",
        input_hint: "仅支持小写字母、数字和连接符",
        modal_logs_title: "运行日志",
        modal_config_title: "环境变量配置",
        hint_restart: "⚠️ 保存后会自动需要重启服务",
        confirm_delete: "确定要彻底删除项目 {name} 吗？数据无法恢复！",
        link_studio: "管理面板",
        link_api: "API 接口",
        lang_switch: "English",
        col_name: "项目名称",
        col_status: "状态",
        col_endpoints: "服务端点",
        col_actions: "操作",
        btn_code: "代码",
        modal_code_title: "函数代码",
        btn_add_func: "新建函数",
        btn_delete_func: "删除",
        placeholder_func_name: "index.ts",
        title_env_vars: "环境变量",
        hint_save_restart: "保存并重启服务以生效",
        // New features
        section_monitoring: "监控面板",
        section_system: "系统运维",
        btn_update_check: "检查更新",
        btn_update_now: "系统更新",
        btn_backup_restore: "备份与恢复",
        modal_system_update_title: "系统更新",
        modal_restore_title: "数据恢复",
        monitor_cpu: "CPU 使用率",
        monitor_mem: "内存使用",
        monitor_net: "网络 I/O",
        table_backup_file: "备份文件",
        table_backup_size: "大小",
        table_backup_date: "日期",
        btn_restore: "立即恢复",
        confirm_restore: "⚠️ 确定要从 {file} 恢复吗？当前数据将被覆盖且无法找回！",
        update_available: "发现新版本！",
        update_uptodate: "当前已是最新系统。",
        msg_update_started: "更新任务已后台启动，系统即将重启...",
        msg_checking_update: "正在检查更新...",
        msg_update_found: "发现新版本: v{version}",
        msg_no_update: "当前已是最新版本",
        btn_skip_update: "暂不更新"
    }
};

type Lang = 'en' | 'zh';

function getLang(c: Context): Lang {
    const cookieLang = getCookie(c, 'lang');
    if (cookieLang === 'zh' || cookieLang === 'en') return cookieLang;

    // Auto-detect from Accept-Language header
    const acceptLang = c.req.header('Accept-Language');
    if (acceptLang && acceptLang.toLowerCase().includes('zh')) {
        return 'zh';
    }

    return 'en';
}

function t(lang: Lang, key: keyof typeof DICTIONARY['en'], params?: Record<string, string>) {
    let text = DICTIONARY[lang][key] || DICTIONARY['en'][key] || key;
    if (params) {
        Object.entries(params).forEach(([k, v]) => {
            text = text.replace(`{${k}}`, v);
        });
    }
    return text;
}



// --- Helper Functions ---
async function exists(path: string) {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

async function createDatabase(dbName: string) {
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

async function getNextPorts() {
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

async function createProject(name: string) {
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
    const serviceKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE2MTI1MzY4MDAsImV4cCI6MTkyODAzNjgwMH0.SIGNATURE_PLACEHOLDER";

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

async function deleteProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    if (!(await exists(projectDir))) return { success: false, message: "Project not found" };

    console.log(`Deleting project ${name}...`);
    try {
        // Stop containers
        const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "down", "-v"], { cwd: projectDir });
        await proc.exited;

        // Remove files
        await deps.$`rm -rf ${projectDir}`;

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

async function checkAndInstallDockerCompose() {
    try {
        const p = deps.spawn(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" });
        if ((await p.exited) === 0) {
            COMPOSE_CMD = ["docker", "compose"];
            return;
        }
    } catch { }

    try {
        const p = deps.spawn(["docker-compose", "version"], { stdout: "ignore", stderr: "ignore" });
        if ((await p.exited) === 0) {
            COMPOSE_CMD = ["docker-compose"];
            return;
        }
    } catch { }

    // Logic for installing docker-compose manually omitted for brevity in Hono port
    // assuming environment is set up or will fall back to local bin
}

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
    } else {
        const password = process.env.ADMIN_PASSWORD || crypto.randomUUID().substring(0, 8);
        await deps.write(AUTH_FILE, password);
        ADMIN_PASSWORD = password;
        console.log(`Generated Admin Password: ${password}`);
    }
}

async function startBase() {
    console.log("Starting Base Platform...");
    const proc = deps.spawn([...COMPOSE_CMD, "up", "-d"], {
        cwd: join(BASE_DIR, "base"),
        stdio: ["inherit", "inherit", "inherit"]
    });
    await proc.exited;
}

// --- Hono App & UI ---

async function ensureFunctionsDir(name: string) {
    const dir = join(INSTANCES_DIR, name, 'packages', 'bun-auth', 'functions');
    if (!(await exists(dir))) {
        await deps.mkdir(dir, { recursive: true });
    }
    return dir;
}

async function listFunctions(name: string) {
    try {
        const dir = await ensureFunctionsDir(name);
        const files = await deps.readdir(dir);
        return { success: true, files: files.filter(f => f.endsWith('.ts') || f.endsWith('.js')) };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

async function getFunction(name: string, filename: string) {
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

async function saveFunction(name: string, filename: string, content: string) {
    try {
        const dir = await ensureFunctionsDir(name);
        await deps.write(join(dir, filename), content);
        return { success: true };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

async function deleteFunction(name: string, filename: string) {
    try {
        const dir = await ensureFunctionsDir(name);
        await deps.rm(join(dir, filename));
        return { success: true };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

const app = new Hono();

import { sign, verify } from "hono/jwt";

// ... Auth Middleware ...
app.use('*', async (c, next) => {
    const path = c.req.path;
    // Allow public routes
    if (path === '/login' || path.startsWith('/static') || path === '/favicon.ico') {
        return next();
    }

    const token = getCookie(c, 'auth_token');
    if (!token) {
        return c.redirect('/login');
    }

    try {
        await verify(token, ADMIN_PASSWORD);
        return next();
    } catch (e) {
        return c.redirect('/login');
    }
});

// ... Login Page Component ...
const LoginPage = ({ error, lang = 'en' }: { error?: string, lang?: Lang }) => (
    <html lang={lang} className="dark">
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Login - SupaCloud</title>
            <script src="https://cdn.tailwindcss.com"></script>
        </head>
        <body className="bg-slate-900 text-slate-200 font-sans min-h-screen flex items-center justify-center relative overflow-hidden">
            {/* Background Effects */}
            <div className="absolute inset-0 z-0">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-emerald-500/10 blur-[120px]"></div>
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-cyan-500/10 blur-[120px]"></div>
            </div>

            <div className="w-full max-w-md p-8 relative z-10">
                <div className="bg-slate-800/50 backdrop-blur-xl border border-white/10 rounded-2xl p-8 shadow-2xl shadow-black/50">
                    <div className="mb-8 text-center">
                        <div className="w-12 h-12 rounded-xl bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30 mx-auto mb-4">
                            <svg className="w-7 h-7 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                            </svg>
                        </div>
                        <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">SupaCloud Manager</h1>
                        <p className="text-slate-500 text-sm mt-2">Sign in to manage your cloud</p>
                    </div>

                    {error && (
                        <div className="mb-6 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm text-center">
                            {error}
                        </div>
                    )}

                    <form method="post" action="/login" className="space-y-4">
                        <div>
                            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">Username</label>
                            <input
                                type="text"
                                name="username"
                                defaultValue="admin"
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg px-4 py-3 text-slate-200 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono text-sm"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-slate-400 mb-1.5 uppercase tracking-wider">Password</label>
                            <input
                                type="password"
                                name="password"
                                className="w-full bg-slate-950/50 border border-slate-700 rounded-lg px-4 py-3 text-slate-200 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono text-sm"
                            />
                        </div>
                        <button type="submit" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-lg transition-all shadow-lg shadow-emerald-900/40 mt-2">
                            Sign In
                        </button>
                    </form>
                </div>
                <div className="text-center mt-6 text-slate-600 text-xs">
                    Protected by SupaCloud Security
                </div>
            </div>
        </body>
    </html>
);

app.get('/login', (c) => c.html(<LoginPage lang={getLang(c)} />));

app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const username = body['username'];
    const password = body['password'];

    // Verify credentials
    if (username === 'admin' && password === ADMIN_PASSWORD) {
        // Sign token
        const token = await sign({ role: 'admin', exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 }, ADMIN_PASSWORD);
        setCookie(c, 'auth_token', token, {
            httpOnly: true,
            path: '/',
            maxAge: 60 * 60 * 24,
            secure: false // Allow http for internal IPs
        });
        return c.redirect('/');
    }

    return c.html(<LoginPage error="Invalid credentials" lang={getLang(c)} />);
});

        const Layout: FC<{ children: any, title?: string, lang?: Lang }> = ({children, title, lang = 'en'}) => (
        <html lang={lang} className="dark">
            <head>
                <meta charset="utf-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>{title ? `${title} - SupaCloud` : 'SupaCloud Manager'}</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.13.3/dist/cdn.min.js"></script>
                <script src="https://unpkg.com/htmx.org@1.9.10"></script>
                <style>{`
                .glass {
                    background: rgba(30, 41, 59, 0.7);
                    backdrop-filter: blur(12px);
                    -webkit-backdrop-filter: blur(12px);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                }
                .glass-card {
                    background: rgba(15, 23, 42, 0.6);
                    backdrop-filter: blur(8px);
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }
            `}</style>
            </head>
            <body className="bg-slate-900 text-slate-200 font-sans min-h-screen flex flex-col">
                <nav className="glass sticky top-0 z-50 px-6 py-4 flex justify-between items-center shadow-lg shadow-black/20">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center border border-emerald-500/30">
                            <svg className="w-5 h-5 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                            </svg>
                        </div>
                        <span className="font-bold text-xl tracking-tight bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
                            SupaCloud
                        </span>
                        <span className="text-xs font-mono bg-slate-800 px-2 py-0.5 rounded text-slate-400 border border-slate-700">v0.1.0</span>
                    </div>
                    <div className="flex gap-4 text-sm font-medium items-center">
                        <a href={`/lang?to=${lang === 'en' ? 'zh' : 'en'}`} className="hover:text-emerald-400 transition-colors">
                            {t(lang, 'lang_switch')}
                        </a>
                    </div>
                </nav>

                <main className="flex-1 container mx-auto px-4 py-8 max-w-6xl">
                    {children}
                </main>

                <footer className="text-center py-6 text-slate-600 text-sm border-t border-slate-800/50 mt-12">
                    <p>Powered by SupaCloud \u2022 Open Source</p>
                </footer>
            </body>
        </html>
        );

app.get('/lang', (c) => {
    const to = c.req.query('to');
        if (to === 'zh' || to === 'en') {
            setCookie(c, 'lang', to);
    }
        return c.redirect('/');
});

app.get('/', async (c) => {
    const lang = getLang(c);
        let projects: string[] = [];
        try {
            projects = await deps.readdir(INSTANCES_DIR);
    } catch { }

        return c.html(
        <Layout lang={lang}>
            <div className="flex flex-col gap-8">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                {/* Stats Cards */}
                <div x-data={`{
                    stats: { cpu: '0%', mem: '0%', net: '0KB' },
                    refresh() {
                        fetch('/system/stats').then(r => r.json()).then(d => this.stats = d).catch(() => {});
                    },
                    init() {
                        this.refresh();
                        setInterval(() => this.refresh(), 3000);
                    }
                }`} className="glass-card rounded-2xl p-6 flex flex-col relative overflow-hidden group col-span-2">
                    <div className="flex justify-between items-start mb-4">
                        <span className="text-slate-400 text-sm font-medium">{t(lang, 'section_monitoring')}</span>
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                    </div>

                    <div className="grid grid-cols-3 gap-4">
                        <div>
                            <div className="text-xs text-slate-500 mb-1">{t(lang, 'monitor_cpu')}</div>
                            <div className="text-2xl font-bold font-mono text-emerald-400" x-text="stats.cpu">0%</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 mb-1">{t(lang, 'monitor_mem')}</div>
                            <div className="text-2xl font-bold font-mono text-purple-400" x-text="stats.mem">0%</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 mb-1">{t(lang, 'monitor_net')}</div>
                            <div className="text-2xl font-bold font-mono text-cyan-400" x-text="stats.net">0KB</div>
                        </div>
                    </div>
                </div>

                <div x-data={`{
                    backupOpen: false,
                    updateStatus: 'idle', // idle, checking, found, uptodate
                    newVersion: '',
                    checkUpdate() {
                        this.updateStatus = 'checking';
                        fetch('/system/check-update')
                            .then(r => r.json())
                            .then(data => {
                                if (data.hasUpdate) {
                                    this.updateStatus = 'found';
                                    this.newVersion = data.version;
                                } else {
                                    this.updateStatus = 'uptodate';
                                    setTimeout(() => this.updateStatus = 'idle', 3000);
                                }
                            })
                            .catch(() => this.updateStatus = 'idle');
                    }
                }`} className="glass-card rounded-2xl p-6 flex flex-col justify-center gap-3">
                    <span className="text-slate-400 text-sm font-medium">{t(lang, 'section_system')}</span>

                    {/* Update Section */}
                    <div className="w-full">
                        <template x-if="updateStatus === 'idle' || updateStatus === 'uptodate' || updateStatus === 'checking'">
                            <button
                                x-on:click="checkUpdate()"
                                disabled={false}
                                className="w-full bg-slate-800 hover:bg-slate-700 text-slate-200 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2"
                            >
                                <span x-show="updateStatus === 'checking'" className="animate-spin w-4 h-4 border-2 border-slate-400 border-t-white rounded-full"></span>
                                <span x-show="updateStatus === 'idle'">{t(lang, 'btn_update_check')}</span>
                                <span x-show="updateStatus === 'checking'">{t(lang, 'msg_checking_update')}</span>
                                <span x-show="updateStatus === 'uptodate'" className="text-emerald-400">{t(lang, 'update_uptodate')}</span>
                            </button>
                        </template>

                        <template x-if="updateStatus === 'found'">
                            <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3">
                                <p className="text-xs text-emerald-400 mb-2 text-center" x-text="'Found new version: v' + newVersion"></p>
                                <div className="flex gap-2">
                                    <button
                                        hx-post="/system/update"
                                        hx-swap="none"
                                        hx-confirm={t(lang, 'msg_update_started')}
                                        className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs py-1.5 rounded transition-colors"
                                    >
                                        {t(lang, 'btn_update_now')}
                                    </button>
                                    <button
                                        x-on:click="updateStatus = 'idle'"
                                        className="px-3 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs py-1.5 rounded transition-colors"
                                    >
                                        {t(lang, 'btn_skip_update')}
                                    </button>
                                </div>
                            </div>
                        </template>
                    </div>

                    {/* Backup Button */}
                    <button {...{ "x-on:click": "backupOpen = true" }} className="w-full bg-emerald-900/40 hover:bg-emerald-900/60 text-emerald-400 border border-emerald-500/20 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" /></svg>
                        {t(lang, 'btn_backup_restore')}
                    </button>

                    {/* Backup Modal - Expanded Size */}
                    <div x-show="backupOpen" className="fixed inset-0 z-50 flex items-center justify-center px-4" style="display: none;">
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "x-on:click": "backupOpen = false" }}></div>
                        <div className="glass rounded-xl p-6 w-full max-w-5xl relative z-10 shadow-2xl animate-fade-in-up flex flex-col max-h-[85vh]">
                            <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                                <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /></svg>
                                {t(lang, 'modal_restore_title')}
                            </h3>

                            <div className="flex-1 overflow-auto bg-slate-950/50 rounded-lg border border-white/5 min-h-[300px]">
                                <table className="w-full text-left">
                                    <thead className="text-xs text-slate-500 uppercase bg-slate-900/50 sticky top-0 backdrop-blur-md">
                                        <tr>
                                            <th className="py-2 px-2 pl-4">{t(lang, 'table_backup_date')}</th>
                                            <th className="py-2 px-2">{t(lang, 'table_backup_size')}</th>
                                            <th className="py-2 px-2 w-full">{t(lang, 'table_backup_file')}</th>
                                            <th className="py-2 px-2 pr-4 text-right">{t(lang, 'col_actions')}</th>
                                        </tr>
                                    </thead>
                                    <tbody hx-get="/system/backups" hx-trigger="intersect once">
                                        <tr><td colSpan={4} className="text-center py-8 text-slate-500 animate-pulse">Loading backups from S3...</td></tr>
                                    </tbody>
                                </table>
                            </div>

                            <div className="flex justify-end gap-3 mt-6">
                                <button type="button" {...{ "x-on:click": "backupOpen = false" }} className="px-4 py-2 hover:bg-slate-800 rounded-lg transition-colors">{t(lang, 'btn_cancel')}</button>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="glass-card rounded-2xl p-6 flex flex-col relative overflow-hidden group">
                    <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                        <svg className="w-16 h-16" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v12H4z" /></svg>
                    </div>
                    <span className="text-slate-400 text-sm font-medium mb-1">Active Projects</span>
                    <span className="text-4xl font-bold text-emerald-400">{projects.length}</span>
                </div>
                <div className="glass-card rounded-2xl p-6 flex flex-col">
                    <span className="text-slate-400 text-sm font-medium mb-1">{t(lang, 'status_label')}</span>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                        <span className="text-emerald-400 font-semibold">{t(lang, 'status_ok')}</span>
                    </div>
                </div>
            </div>

            <div className="flex justify-between items-end mb-6">
                <h2 className="text-2xl font-bold flex items-center gap-2">
                    <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                    {t(lang, 'projects_title')}
                </h2>

                <div x-data="{ open: false }">
                    <button
                        {...{ "x-on:click": "open = true" }}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg font-medium transition-all shadow-lg shadow-emerald-900/40 flex items-center gap-2"
                    >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                        {t(lang, 'btn_new')}
                    </button>

                    {/* Modal */}
                    <div x-show="open" className="fixed inset-0 z-50 flex items-center justify-center px-4" style="display: none;">
                        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "x-on:click": "open = false" }}></div>
                        <div className="glass rounded-xl p-8 w-full max-w-md relative z-10 shadow-2xl animate-fade-in-up">
                            <h3 className="text-xl font-bold mb-4">{t(lang, 'modal_create_title')}</h3>
                            <form hx-post="/projects" hx-target="#project-list" hx-swap="afterbegin" {...{ "hx-on:htmx:after-request": "open = false" }}>
                                <div className="mb-6">
                                    <label className="block text-sm font-medium text-slate-400 mb-2">{t(lang, 'input_name_label')}</label>
                                    <input
                                        name="name"
                                        type="text"
                                        required
                                        pattern="^[a-z0-9-]+$"
                                        placeholder={t(lang, 'input_name_placeholder')}
                                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition-all font-mono text-sm"
                                    />
                                    <p className="text-xs text-slate-500 mt-2">{t(lang, 'input_hint')}</p>
                                </div>
                                <div className="flex justify-end gap-3">
                                    <button type="button" {...{ "x-on:click": "open = false" }} className="px-4 py-2 hover:bg-slate-800 rounded-lg transition-colors">{t(lang, 'btn_cancel')}</button>
                                    <button type="submit" className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 rounded-lg font-medium transition-colors">
                                        {t(lang, 'btn_create')}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            </div >

            <div className="glass rounded-2xl overflow-hidden min-h-[300px]">
                <div className="grid grid-cols-12 gap-4 p-4 border-b border-white/5 text-xs text-slate-400 font-semibold uppercase tracking-wider">
                    <div className="col-span-4">{t(lang, 'col_name')}</div>
                    <div className="col-span-3">{t(lang, 'col_status')}</div>
                    <div className="col-span-3">{t(lang, 'col_endpoints')}</div>
                    <div className="col-span-2 text-right">{t(lang, 'col_actions')}</div>
                </div>
                <div id="project-list" className="divide-y divide-white/5">
                    {projects.map(name => <ProjectRow name={name} lang={lang} />)}
                </div>
            </div>
            </div>
        </Layout >
        );
});

        const ProjectRow = ({name, lang = 'en'}: {name: string, lang?: Lang }) => (
        <div className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-white/5 transition-colors group">
            <div className="col-span-4 flex items-center gap-3">
                <div className="w-10 h-10 rounded bg-gradient-to-br from-slate-700 to-slate-800 flex items-center justify-center font-bold text-slate-300 font-mono text-lg border border-white/5">
                    {name.substring(0, 2).toUpperCase()}
                </div>
                <div>
                    <div className="font-semibold text-slate-200">{name}</div>
                    <div className="text-xs text-slate-500">Postgres 15 \u2022 2 Services</div>
                </div>
            </div>
            <div className="col-span-3">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    {t(lang, 'status_ok')}
                </span>
            </div>
            <div className="col-span-3 flex flex-col gap-1">
                <a href={`http://${name}.studio.${ROOT_DOMAIN}`} target="_blank" className="text-xs text-cyan-400 hover:underline flex items-center gap-1">
                    {t(lang, 'link_studio')}
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </a>
                <a href={`http://${name}.${ROOT_DOMAIN}`} target="_blank" className="text-xs text-slate-400 hover:text-slate-200 transaction-colors">{t(lang, 'link_api')}</a>
            </div>
            <div className="col-span-2 text-right opacity-0 group-hover:opacity-100 transition-opacity flex justify-end gap-2">
                {/* Start/Stop Buttons */}
                <button
                    hx-post={`/projects/${name}/stop`}
                    hx-swap="none"
                    className="text-amber-400 hover:bg-white/10 hover:text-amber-300 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                    title={t(lang, 'btn_stop')}
                    onclick="setTimeout(() => window.location.reload(), 2000)"
                >
                    {t(lang, 'btn_stop')}
                </button>
                <button
                    hx-post={`/projects/${name}/start`}
                    hx-swap="none"
                    className="text-emerald-400 hover:bg-white/10 hover:text-emerald-300 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                    title={t(lang, 'btn_start')}
                    onclick="setTimeout(() => window.location.reload(), 2000)"
                >
                    {t(lang, 'btn_start')}
                </button>

                <button
                    hx-get={`/projects/${name}/logs`}
                    hx-target="body"
                    hx-swap="beforeend"
                    title={t(lang, 'btn_logs')}
                    className="text-slate-400 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
                >
                    {t(lang, 'btn_logs')}
                </button>
                <button
                    hx-get={`/projects/${name}/config`}
                    hx-target="body"
                    hx-swap="beforeend"
                    title={t(lang, 'btn_config')}
                    className="text-slate-400 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
                >
                    {t(lang, 'btn_config')}
                </button>
                <button
                    hx-get={`/projects/${name}/code`}
                    hx-target="body"
                    hx-swap="beforeend"
                    title={t(lang, 'btn_code')}
                    className="text-slate-400 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
                >
                    {t(lang, 'btn_code')}
                </button>
                <button
                    hx-post={`/projects/${name}/restart`}
                    hx-swap="none"
                    title={t(lang, 'btn_restart')}
                    className="text-slate-400 hover:bg-white/10 hover:text-white px-3 py-1.5 rounded text-xs font-medium transition-colors"
                >
                    {t(lang, 'btn_restart')}
                </button>
                <button
                    hx-delete={`/projects/${name}`}
                    hx-target="closest div.grid"
                    hx-swap="outerHTML"
                    hx-confirm={t(lang, 'confirm_delete', { name })}
                    className="text-red-400 hover:bg-red-500/10 hover:text-red-300 px-3 py-1.5 rounded text-xs font-medium transition-colors"
                >
                    {t(lang, 'btn_delete')}
                </button>
            </div>
        </div>
        );

app.post('/projects', async (c) => {
            let name: string;
        const contentType = c.req.header('Content-Type');

        if (contentType && contentType.includes('application/json')) {
        const json = await c.req.json();
        name = json['name'];
    } else {
        const body = await c.req.parseBody();
        name = body['name'] as string;
    }

        if (!name) return c.json({error: 'Name required' }, 400);

        const res = await createProject(name);
        if (res.success) {
        // Support JSON for API clients/tests
        const accept = c.req.header('Accept');
        if (accept && accept.includes('application/json')) {
            return c.json(res);
        }
        // Return just the row HTML for HTMX to inject
        return c.html(<ProjectRow name={name} lang={getLang(c)} />);
    } else {
        return c.text(res.message || "Failed", 500);
    }
});

app.post('/projects/:name/start', async (c) => {
    const name = c.req.param('name');
    const res = await startProject(name);
    if (res.success) {
        return c.body(null, 204);
    } else {
        return c.text(res.message || "Failed", 500);
    }
});

app.post('/projects/:name/stop', async (c) => {
    const name = c.req.param('name');
    const res = await stopProject(name);
    if (res.success) {
        return c.body(null, 204);
    } else {
        return c.text(res.message || "Failed", 500);
    }
});

app.post('/projects/:name/restart', async (c) => {
    const name = c.req.param('name');
    const res = await restartProject(name);
    if (res.success) {
        return c.body(null, 204);
    } else {
        return c.text(res.message || "Failed", 500);
    }
});

app.delete('/projects/:name', async (c) => {
    const name = c.req.param('name');
    const projectDir = join(INSTANCES_DIR, name);

    if (!(await exists(projectDir))) return c.text("Project not found", 404);

    try {
        const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "down"], { cwd: projectDir, stdio: ["ignore", "ignore", "ignore"] });
        await proc.exited;

        await deps.rm(projectDir, { recursive: true, force: true });
        return c.body(null, 200);
    } catch (e: any) {
        return c.text(e.message, 500);
    }
});

        // ... Upgrade Logic ...

        // --- Helpers ---

        async function getProjectLogs(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
        if (!(await exists(projectDir))) return {success: false, message: "Project not found" };
        try {
        // Use docker compose logs
        const output = await deps.$`docker compose -p ${name} logs --tail=100`.cwd(projectDir).text();
        return {success: true, logs: output };
    } catch (e) {
        return {success: false, message: String(e) };
    }
}

        async function getProjectConfig(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
        try {
        const envPath = join(projectDir, ".env");
        if (!(await exists(envPath))) return {success: false, message: "Config not found" };
        const content = await deps.file(envPath).text();
        return {success: true, config: content };
    } catch (e) {
        return {success: false, message: String(e) };
    }
}

        async function updateProjectConfig(name: string, content: string) {
    const projectDir = join(INSTANCES_DIR, name);
        try {
        const envPath = join(projectDir, ".env");
        await deps.write(envPath, content);
        return {success: true };
    } catch (e) {
        return {success: false, message: String(e) };
    }
}

// ... Routes ...

app.get('/projects/:name/logs', async (c) => {
    const lang = getLang(c);
        const name = c.req.param('name');
        const res = await getProjectLogs(name);
        if (!res.success) return c.text(res.message || "Error", 500);

        return c.html(
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" id="modal-container">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }}></div>
            <div className="glass rounded-xl p-6 w-full max-w-4xl max-h-[80vh] flex flex-col relative z-10 shadow-2xl animate-fade-in-up">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="text-xl font-bold flex items-center gap-2">
                        <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                        {t(lang, 'modal_logs_title')}: {name}
                    </h3>
                    <button {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }} className="text-slate-400 hover:text-white">
                        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>
                <pre className="flex-1 overflow-auto bg-slate-950 p-4 rounded-lg text-xs font-mono text-slate-300 whitespace-pre-wrap border border-slate-800">
                    {res.logs}
                </pre>
            </div>
        </div>
        );
});

app.get('/projects/:name/config', async (c) => {
    const lang = getLang(c);
        const name = c.req.param('name');
        const res = await getProjectConfig(name);
        if (!res.success) return c.text(res.message || "Error", 500);

        const isDeno = res.config?.includes("deno");

        return c.html(
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" id="modal-container">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }}></div>
            <div className="glass rounded-xl p-6 w-full max-w-2xl relative z-10 shadow-2xl animate-fade-in-up">
                <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                    <svg className="w-5 h-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                    {t(lang, 'modal_config_title')}: {name}
                </h3>
                <form hx-post={`/projects/${name}/config`} hx-target="#modal-container" hx-swap="delete">
                    <div className="mb-4">
                        <textarea name="config" className="w-full h-64 bg-slate-950 border border-slate-700 rounded-lg p-4 font-mono text-xs text-slate-300 focus:outline-none focus:border-emerald-500">{res.config}</textarea>
                    </div>
                    <div className="flex justify-between items-center">
                        <span className="text-xs text-yellow-500/80 bg-yellow-500/10 px-2 py-1 rounded border border-yellow-500/20">{t(lang, 'hint_restart')}</span>
                        <div className="flex gap-3">
                            <button type="button" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }} className="px-4 py-2 hover:bg-slate-800 rounded-lg transition-colors text-sm">{t(lang, 'btn_cancel')}</button>
                            <button type="submit" className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2 rounded-lg font-medium transition-colors text-sm">{t(lang, 'btn_save')}</button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
        );
});

app.post('/projects/:name/config', async (c) => {
    const name = c.req.param('name');
        const body = await c.req.parseBody();
        const config = body['config'] as string;
        await updateProjectConfig(name, config);
        return c.body(null, 200);
});

app.get('/projects/:name/code', async (c) => {
    const lang = getLang(c);
    const name = c.req.param('name');
    const listRes = await listFunctions(name);
    const files = listRes.success ? listRes.files || [] : [];
    
    // Default to first file if exists, else empty
    const selectedFile = c.req.query('file') || (files.length > 0 ? files[0] : '');
    let fileContent = '';
    
    if (selectedFile) {
        const fileRes = await getFunction(name, selectedFile);
        if (fileRes.success) {
            fileContent = fileRes.code || '';
        }
    }

    return c.html(
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" id="modal-container">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }}></div>
        <div className="glass rounded-xl w-full max-w-5xl relative z-10 shadow-2xl animate-fade-in-up flex h-[80vh] overflow-hidden" x-data={`{
            currentFile: '${selectedFile}',
            isNew: ${!selectedFile},
            content: \`${fileContent.replace(/`/g, '\\`')}\`,
            files: ${JSON.stringify(files)},
            loadFile(file) {
                this.currentFile = file;
                this.isNew = false;
                fetch(\`/projects/${name}/code/\${file}\`).then(r => r.text()).then(t => this.content = t);
            },
            newFile() {
                this.currentFile = '';
                this.isNew = true;
                this.content = '';
            },
            async save() {
                if (!this.currentFile) return;
                await fetch(\`/projects/${name}/code/\${this.currentFile}\`, {
                    method: 'POST',
                    body: this.content
                });
                // Simple reload to refresh list if needed
                htmx.ajax('GET', \`/projects/${name}/code?file=\${this.currentFile}\`, '#modal-container');
            },
            async del() {
                if (!confirm('${t(lang, 'confirm_delete').replace('{name}', "' + this.currentFile + '")}')) return;
                await fetch(\`/projects/${name}/code/\${this.currentFile}\`, { method: 'DELETE' });
                htmx.ajax('GET', \`/projects/${name}/code\`, '#modal-container');
            }
        }`}>
            {/* Sidebar */}
            <div className="w-1/4 bg-slate-950/50 border-r border-slate-800 flex flex-col">
                <div className="p-4 border-b border-white/5 flex justify-between items-center">
                    <h3 className="font-bold text-slate-300">{t(lang, 'modal_code_title')}</h3>
                    <button x-on:click="newFile()" className="text-emerald-400 hover:text-emerald-300 text-xs bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20 transition-colors">
                        + {t(lang, 'btn_add_func')}
                    </button>
                </div>
                <div className="flex-1 overflow-auto p-2 space-y-1">
                    <template x-for="file in files">
                        <button 
                            x-on:click="loadFile(file)"
                            {...{ ":class": "currentFile === file ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200 border-transparent'" }}
                            className="w-full text-left px-3 py-2 rounded text-sm font-mono border transition-all truncate"
                            x-text="file"
                        ></button>
                    </template>
                </div>
            </div>

            {/* Editor Area */}
            <div className="flex-1 flex flex-col bg-slate-900/50">
                <div className="p-4 border-b border-white/5 flex items-center gap-4 bg-slate-900/30">
                    <div className="flex-1">
                        <input 
                            type="text" 
                            x-model="currentFile" 
                            {...{ ":disabled": "!isNew" }}
                            placeholder={t(lang, 'placeholder_func_name')}
                            className="bg-transparent text-slate-200 font-mono text-sm focus:outline-none w-full placeholder-slate-600"
                        />
                    </div>
                    <div className="flex gap-2">
                        <button x-show="!isNew" x-on:click="del()" className="text-red-400 hover:bg-red-500/10 px-3 py-1.5 rounded text-xs transition-colors">{t(lang, 'btn_delete_func')}</button>
                        <button x-on:click="save()" className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded text-xs font-medium transition-colors">{t(lang, 'btn_save')}</button>
                    </div>
                </div>
                <textarea 
                    x-model="content"
                    className="flex-1 w-full bg-slate-950 p-4 font-mono text-xs text-slate-300 focus:outline-none resize-none" 
                    spellCheck="false"
                ></textarea>
                 <div className="p-2 bg-slate-950 border-t border-slate-800 text-right">
                    <span className="text-xs text-yellow-500/80">{t(lang, 'hint_save_restart')}</span>
                </div>
            </div>
            
            {/* Close Button */}
            <button {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }} className="absolute top-2 right-2 text-slate-500 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
            </button>
        </div>
    </div>
    );
});

app.get('/projects/:name/code/:file', async (c) => {
    const name = c.req.param('name');
    const file = c.req.param('file');
    const res = await getFunction(name, file);
    return c.text(res.success ? (res.code || '') : '');
});

app.post('/projects/:name/code/:file', async (c) => {
    const name = c.req.param('name');
    const file = c.req.param('file');
    const content = await c.req.text();
    await saveFunction(name, file, content);
    return c.body(null, 200);
});

app.delete('/projects/:name/code/:file', async (c) => {
    const name = c.req.param('name');
    const file = c.req.param('file');
    await deleteFunction(name, file);
    return c.body(null, 200);
});



// --- System Operations ---

app.get('/system/check-update', async (c) => {
    try {
        const res = await fetch("https://api.github.com/repos/zuohuadong/supacloud/releases/latest", {
            headers: { "User-Agent": "SupaCloud-Manager" }
        });
        if (!res.ok) throw new Error("Failed to fetch release info");
        const data = await res.json() as any;
        const latestVersion = data.tag_name || "v0.0.0";
        // Simple version check (string comparison for now)
        // Ideally parse semver
        const currentVersion = "v0.1.0"; 
        const hasUpdate = latestVersion !== currentVersion && latestVersion !== "0.1.0";

        return c.json({ hasUpdate, version: latestVersion });
    } catch (e) {
        return c.json({ hasUpdate: false, error: String(e) });
    }
});

app.get('/system/stats', async (c) => {
    // Requires 'docker stats' access
    try {
        // Run docker stats once, format as JSON
        // Note: Formatting might be tricky across OS. Simplest is basic parsing.
        // Or assume we monitor 'base' containers + project containers.
        // For simplicity, we just return mock data or basic usage if possible.
        // Real implementation would use `docker stats --no-stream --format "{{.Name }}:{{.CPUPerc }}:{{.MemPerc }}:{{.NetIO }}"`
        const proc = deps.spawn(["docker", "stats", "--no-stream", "--format", "{{.Name }}|{{.CPUPerc }}|{{.MemPerc }}|{{.NetIO }}"], {stdout: "pipe" });
        const output = await new Response(proc.stdout).text();

        // Aggregate logic
        let cpuTotal = 0;
        let memTotal = 0; // Simple sum of percentages? Or just max?
        let netTotal = "0KB"; // Hard to parsing units reliably without lib.

        let cpuSum = 0;
        let count = 0;

        output.trim().split('\n').forEach(line => {
            const parts = line.split('|');
            if (parts.length >= 2) {
                const cpu = parseFloat(parts[1].replace('%', ''));
        if (!isNaN(cpu)) cpuSum += cpu;
        count++;
            }
        });

        // Mocking NET for now as it needs complex parsing
        // Memory as average % utilization of VM?
        // Let's just return aggregate CPU usage of all docker containers
        return c.json({
            cpu: `${cpuSum.toFixed(1)}%`,
            mem: count > 0 ? "Active" : "Idle", // Placeholder
        net: `${count} Containers`
        });
    } catch (e) {
        return c.json({cpu: 'Err', mem: 'Err', net: 'Err' });
    }
});

app.post('/system/update', async (c) => {
    // 1. Update Base System
    try {
        // Run in detached background to avoid timeout
        // But we want to give feedback...
        // For now: Pull images and restart services in 'base'

        // Note: Manager itself might be in 'base'. Restarting it will kill this request.
        // We accept that. It will restart.

        const proc = deps.spawn([...COMPOSE_CMD, "pull"], {cwd: join(BASE_DIR, "base"), stdio: ["ignore", "inherit", "inherit"] });
        await proc.exited;

        const procUp = deps.spawn([...COMPOSE_CMD, "up", "-d"], {cwd: join(BASE_DIR, "base"), stdio: ["ignore", "inherit", "inherit"] });
        // We don't await this fully if it kills the manager.
        // But assuming manager is "supacloud" binary or "base" container...

        return c.text("Update triggered", 200);
    } catch (e) {
        return c.text(`Update failed: ${e}`, 500);
    }
});

app.get('/system/backups', async (c) => {
    // List backups from S3 (via backup-service container)
    // We execute 'aws s3 ls s3://$BACKUP_BUCKET/' inside backup-service
    // Command: docker exec backup-service sh -c "aws --endpoint-url $S3_ENDPOINT s3 ls s3://$BACKUP_BUCKET/"

    // We need to parse environment variables to get BUCKET name if dynamic.
    // For now assuming hardcoded or readable.

    try {
        // We can just Exec into backup-service
        const proc = deps.spawn(["docker", "exec", "backup-service", "sh", "-c", "export AWS_ACCESS_KEY_ID=$GARAGE_ACCESS_KEY; export AWS_SECRET_ACCESS_KEY=$GARAGE_SECRET_KEY; aws --endpoint-url $S3_ENDPOINT s3 ls s3://$BACKUP_BUCKET/"], {stdout: "pipe" });
        const output = await new Response(proc.stdout).text();
        // Parse output
        // Format: 2023-12-27 12:00:00  123456 global_db_...
        const files = output.trim().split('\n').map(line => {
            const parts = line.trim().split(/\s+/);
        if (parts.length < 4) return null;
        return {
            date: `${parts[0]} ${parts[1]}`,
        size: parts[2],
        name: parts.slice(3).join(' ')
            };
        }).filter(Boolean);

        const lang = getCookie(c, 'lang') || 'en'; // Simple fallback

        return c.html(
        <>
            {files.length === 0 && (
                <tr><td colSpan={4} className="text-center py-8 text-slate-500">No backups found</td></tr>
            )}
            {files.map((f: any) => (
                <tr className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="py-3 px-2 font-mono text-xs text-slate-400">{f.date}</td>
                    <td className="py-3 px-2 font-mono text-xs text-emerald-400">{f.size}</td>
                    <td className="py-3 px-2 font-mono text-xs text-slate-300">{f.name}</td>
                    <td className="py-3 px-2 text-right">
                        <button
                            hx-post="/system/restore"
                            hx-vals={JSON.stringify({ file: f.name })}
                            hx-confirm={t(lang as any, 'confirm_restore').replace('{file}', f.name)}
                            className="text-xs bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white px-2 py-1 rounded transition-colors"
                        >
                            {t(lang as any, 'btn_restore')}
                        </button>
                    </td>
                </tr>
            ))}
        </>
        );
    } catch (e) {
        return c.html(<tr><td colSpan={4} className="text-center py-4 text-red-500">Error loading backups</td></tr>);
    }
});

app.post('/system/restore', async (c) => {
    const body = await c.req.parseBody();
        const file = body['file'] as string;
        if (!file) return c.text("Filename required", 400);

        try {
        // Execute restore script
        const proc = deps.spawn(["docker", "exec", "backup-service", "/restore.sh", file]);
        await proc.exited;
        if (proc.exitCode !== 0) throw new Error("Restore script failed");

        return c.text("Restore Complete", 200);
    } catch (e) {
        return c.text(String(e), 500);
    }
});


        // ...

        async function startProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    if (!(await exists(projectDir))) return { success: false, message: "Project not found" };

    try {
        const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "start"], { cwd: projectDir });
        await proc.exited;
        return { success: true };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

async function stopProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    if (!(await exists(projectDir))) return { success: false, message: "Project not found" };

    try {
        const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "stop"], { cwd: projectDir });
        await proc.exited;
        return { success: true };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

async function restartProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
        if (!(await exists(projectDir))) return {success: false, message: "Project not found" };

        console.log(`Restarting project ${name}...`);
        try {
        const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "restart"], {cwd: projectDir });
        await proc.exited;
        return {success: true };
    } catch (e) {
        return {success: false, message: String(e) };
    }
}

        // Upgrade Logic
        const CURRENT_VERSION = "0.1.0";
        const REPO = "zuohuadong/supacloud";

        async function upgradeManager() {
    // Safety check: Don't upgrade if running as source (using bun interpreter)
    if (process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe")) {
            console.log("⚠️  Running in interpreter mode. Please use 'git pull' to upgrade source code.");
        return;
    }

        console.log(`Checking for updates... (Current: v${CURRENT_VERSION})`);
        try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
        if (!res.ok) {
            if (res.status === 404) {
            console.log("No releases found.");
        return;
            }
        throw new Error(`GitHub API Error: ${res.statusText}`);
        }

        const release = await res.json();
        const latestVersion = release.tag_name.replace(/^v/, '');

        if (latestVersion === CURRENT_VERSION) {
            console.log("✅ You are already on the latest version.");
        return;
        }

        console.log(`🚀 New version found: v${latestVersion}`);


        const targetMap: Record<string, string> = {
            "linux-x64": "supacloud-linux-x64",
        "linux-arm64": "supacloud-linux-arm64",
        "darwin-x64": "supacloud-darwin-x64",
        "darwin-arm64": "supacloud-darwin-arm64",
        "win32-x64": "supacloud-windows-x64.exe"
        };

        const key = `${process.platform}-${process.arch}`;
        const assetName = targetMap[key];

        if (!assetName) {
            console.error(`❌ Auto-upgrade not supported for platform: ${process.platform} (${process.arch})`);
        console.log("Supported targets:", Object.keys(targetMap).join(", "));
        return;
        }

        const asset = release.assets.find((a: any) => a.name === assetName);

        if (!asset) {
            console.error(`❌ No compatible asset '${assetName}' found in release v${latestVersion}`);
            console.log("Available assets:", release.assets.map((a: any) => a.name).join(", "));
        return;
        }

        console.log(`⬇️  Downloading ${asset.browser_download_url}...`);

        const dlRes = await fetch(asset.browser_download_url);
        if (!dlRes.ok) throw new Error("Download failed");

        const buffer = await dlRes.arrayBuffer();
        const binPath = process.execPath;
        const tmpPath = binPath + ".new";
        const backupPath = binPath + ".old";

        // Write new binary
        await deps.write(tmpPath, new Uint8Array(buffer));

        if (process.platform !== "win32") {
            await deps.$`chmod +x ${tmpPath}`;
        }

        // Atomic replacement
        console.log("📦 Installing update...");
        try {
            // Backup current
            await deps.rename(binPath, backupPath);
        // Move new to current
        await deps.rename(tmpPath, binPath);

            // On Windows, specific cleanup might be tricky if process handles linger, 
            // but rename is generally safe for running executables.
            // We leave backupPath there just in case.
        } catch (err) {
            console.error("Failed to replace binary:", err);
        // Try to restore
        try {
                if (await exists(backupPath)) {
            await deps.rename(backupPath, binPath);
                }
            } catch (restoreErr) {
            console.error("Failed to restore backup:", restoreErr);
            }
        throw err;
        }

        console.log(`✅ Successfully upgraded to v${latestVersion}`);
        console.log("Please restart the service to apply changes.");
        process.exit(0);

    } catch (e) {
            console.error("❌ Upgrade failed:", e);
        process.exit(1);
    }
}

        // Export functions for testing
        const handler = app.fetch;
        export {createProject, getNextPorts, exists, createDatabase, initManager, handler, upgradeManager};

        // Main Entry Point
        if (import.meta.main) {
    const argOffset = 2; // Approximate
        const command = process.argv[argOffset] || "help";

        await initManager();
        await checkAndInstallDockerCompose();

        if (command === "start") {
            await startBase();
        console.log("Starting Manager API...");
        serve({
            fetch: app.fetch,
        port: 8888,
        });
        console.log(`Manager listening on http://localhost:8888`);
    } else if (command === "create") {
        // CLI Create
        const name = process.argv[argOffset + 1];
        if (name) await createProject(name);
    } else if (command === "upgrade") {
            await upgradeManager();
    }
    // ... Other CLI commands (status, help) mapped similarly if needed
    // For now we focus on the Web UI
}
