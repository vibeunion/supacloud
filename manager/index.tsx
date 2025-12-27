
import { serve, file as bunFile, write as bunWrite, spawn as bunSpawn, Glob as BunGlob } from "bun";
import { readdir, mkdir } from "node:fs/promises";
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
    mkdir
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
        modal_config_title: "Configuration",
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
        hint_save_restart: "Save changes and restart service to apply"
    },
    zh: {
        status_label: "系统状态",
        status_ok: "运行正常",
        projects_title: "项目管理",
        btn_new: "新建项目",
        btn_restart: "重启服务",
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
        hint_save_restart: "保存并重启服务以生效"
    }
};

type Lang = 'en' | 'zh';

function getLang(c: Context): Lang {
    const cookieLang = getCookie(c, 'lang') as Lang;
    return (cookieLang === 'zh' || cookieLang === 'en') ? cookieLang : 'en';
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
    const file = deps.file(path);
    return await file.exists();
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

async function getProjectCode(name: string) {
    try {
        const codePath = join(INSTANCES_DIR, name, 'packages', 'bun-auth', 'index.ts');
        const file = deps.file(codePath);
        if (!(await file.exists())) return { success: false, message: "Functions file not found" };
        const code = await file.text();
        return { success: true, code };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

async function updateProjectCode(name: string, content: string) {
    try {
        const codePath = join(INSTANCES_DIR, name, 'packages', 'bun-auth', 'index.ts');
        await deps.write(codePath, content);
        return { success: true };
    } catch (e: any) {
        return { success: false, message: e.message };
    }
}

const app = new Hono();

app.use('*', async (c, next) => {
    const auth = basicAuth({ username: "admin", password: ADMIN_PASSWORD });
    return auth(c, next);
});

const Layout: FC<{ children: any, title?: string, lang?: Lang }> = ({ children, title, lang = 'en' }) => (
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

app.get('/', async (c) => {
    const lang = getLang(c);
    let projects: string[] = [];
    try {
        projects = await deps.readdir(INSTANCES_DIR);
    } catch { }

    return c.html(
        <Layout lang={lang}>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                {/* Stats Cards */}
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
                                        pattern="[-a-z0-9]+"
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
        </Layout >
    );
});

const ProjectRow = ({ name, lang = 'en' }: { name: string, lang?: Lang }) => (
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

    if (!name) return c.json({ error: 'Name required' }, 400);

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

app.post('/projects/:name/restart', async (c) => {
    const name = c.req.param('name');
    const res = await restartProject(name);
    if (res.success) {
        return c.body(null, 204);
    } else {
        return c.text(res.message || "Failed", 500);
    }
});

// ... Upgrade Logic ...

// --- Helpers ---

async function getProjectLogs(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    if (!(await exists(projectDir))) return { success: false, message: "Project not found" };
    try {
        // Use docker compose logs
        const output = await deps.$`docker compose -p ${name} logs --tail=100`.cwd(projectDir).text();
        return { success: true, logs: output };
    } catch (e) {
        return { success: false, message: String(e) };
    }
}

async function getProjectConfig(name: string) {
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

async function updateProjectConfig(name: string, content: string) {
    const projectDir = join(INSTANCES_DIR, name);
    try {
        const envPath = join(projectDir, ".env");
        await deps.write(envPath, content);
        return { success: true };
    } catch (e) {
        return { success: false, message: String(e) };
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
    const res = await getProjectCode(name);
    if (!res.success) return c.text(res.message || "Error", 500);

    return c.html(
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" id="modal-container">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" {...{ "hx-on:click": "document.getElementById('modal-container').remove()" }}></div>
            <div className="glass rounded-xl p-6 w-full max-w-4xl relative z-10 shadow-2xl animate-fade-in-up flex flex-col h-[80vh]">
                <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                    <svg className="w-5 h-5 text-slate-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>
                    {t(lang, 'modal_code_title')}: {name}
                </h3>
                <form hx-post={`/projects/${name}/code`} hx-target="#modal-container" hx-swap="delete" className="flex-1 flex flex-col min-h-0">
                    <div className="flex-1 mb-4 min-h-0 bg-slate-950 border border-slate-700 rounded-lg overflow-hidden">
                        <textarea name="code" className="w-full h-full bg-slate-950 p-4 font-mono text-xs text-slate-300 focus:outline-none focus:border-emerald-500 resize-none" spellCheck="false">{res.code}</textarea>
                    </div>
                    <div className="flex justify-between items-center shrink-0">
                        <span className="text-xs text-yellow-500/80 bg-yellow-500/10 px-2 py-1 rounded border border-yellow-500/20">{t(lang, 'hint_save_restart')}</span>
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

app.post('/projects/:name/code', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.parseBody();
    const code = body['code'] as string;
    await updateProjectCode(name, code);
    return c.body(null, 200);
});

// ...

async function restartProject(name: string) {
    const projectDir = join(INSTANCES_DIR, name);
    if (!(await exists(projectDir))) return { success: false, message: "Project not found" };

    console.log(`Restarting project ${name}...`);
    try {
        const proc = deps.spawn([...COMPOSE_CMD, "-p", name, "restart"], { cwd: projectDir });
        await proc.exited;
        return { success: true };
    } catch (e) {
        return { success: false, message: String(e) };
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

        // Determine asset name based on platform (assuming Linux x64 for server)
        // Ideally checking process.platform/arch
        const assetName = "supacloud-linux-x64";
        const asset = release.assets.find((a: any) => a.name === assetName);

        if (!asset) {
            console.error(`❌ No compatible asset '${assetName}' found in release v${latestVersion}`);
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
        await deps.$`chmod +x ${tmpPath}`;

        // Atomic replacement
        console.log("📦 Installing update...");
        try {
            // Backup current
            await deps.$`mv ${binPath} ${backupPath}`;
            // Move new to current
            await deps.$`mv ${tmpPath} ${binPath}`;
            // Clean backup (optional, keeping it explicitly might be safer for rollback)
            // await deps.$`rm ${backupPath}`; 
        } catch (err) {
            console.error("Failed to replace binary:", err);
            // Try to restore
            await deps.$`mv ${backupPath} ${binPath}`;
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
export { createProject, getNextPorts, exists, createDatabase, initManager, handler, upgradeManager };

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
