
import { Hono } from "hono";
import { getLang } from "../lib/i18n";
import { deps } from "../lib/deps";
import { INSTANCES_DIR } from "../lib/config";
import { Dashboard } from "../components/Dashboard";
import { LogsModal } from "../components/LogsModal";
import { ConfigModal } from "../components/ConfigModal";
import { FunctionModal } from "../components/FunctionModal";
import { BackupList } from "../components/BackupList";
import { getProjectConfig, listFunctions, getFunction, getProjectRuntime } from "../lib/projects";
import { join } from "node:path";
import { setCookie } from "hono/cookie";

export const uiApp = new Hono();

// Dashboard
uiApp.get('/', async (c) => {
    const lang = getLang(c);
    let projects: string[] = [];
    try {
        projects = await deps.readdir(INSTANCES_DIR);
    } catch { }

    const projectData = await Promise.all(projects.map(async name => {
        const runtime = await getProjectRuntime(name);
        return { name, runtime };
    }));

    return c.html(<Dashboard projects={projectData} lang={lang} />);
});

// Language Switcher
uiApp.get('/lang', (c) => {
    const to = c.req.query('to');
    if (to === 'zh' || to === 'en') {
        setCookie(c, 'lang', to);
    }
    return c.redirect('/');
});


// Modals (HTMX)

uiApp.get('/projects/:name/logs', async (c) => {
    const lang = getLang(c);
    const name = c.req.param('name');

    // We need to fetch logs here. Note: Logic duplication from API?
    // The original code had a getProjectLogs helper. Let's assume we need to import or reimplement log fetching.
    // It's better to reuse logic. I should export getProjectLogs from api or proper lib.
    // It's not in lib/projects.ts yet. Let's add it there later contextually or just inline the simple logic.
    // Logic: docker compose -p name logs --tail=100
    // I'll inline it for now using the same deps.

    let logs = '';
    try {
        const projectDir = join(INSTANCES_DIR, name);
        // Ensure deps.$ works or use deps.spawn
        // Note: deps.$ returns a Promise<Process> which has .text() in Bun, but my mock object structure in tests might need ensuring
        // In lib/deps.ts, $ is exported.
        logs = await deps.$`docker compose -p ${name} logs --tail=100`.cwd(projectDir).text();
    } catch (e) {
        logs = `Error fetching logs: ${e}`;
    }

    return c.html(<LogsModal name={name} logs={logs} lang={lang} />);
});

uiApp.get('/projects/:name/config', async (c) => {
    const lang = getLang(c);
    const name = c.req.param('name');
    const res = await getProjectConfig(name);
    if (!res.success) return c.text(res.message || "Error", 500);

    return c.html(<ConfigModal name={name} config={res.config || ''} lang={lang} />);
});

uiApp.get('/projects/:name/code', async (c) => {
    const lang = getLang(c);
    const name = c.req.param('name');
    const listRes = await listFunctions(name);
    if (!listRes.success) return c.text(listRes.message || "Error", 500);

    const files = listRes.files || [];
    const selectedFile = c.req.query('file') || files[0] || '';
    let fileContent = '';

    if (selectedFile) {
        const fileRes = await getFunction(name, selectedFile);
        if (fileRes.success) {
            fileContent = fileRes.code || '';
        }
    }

    return c.html(<FunctionModal name={name} files={files} selectedFile={selectedFile} fileContent={fileContent} lang={lang} />);
});

// System Backups Fragment
uiApp.get('/system/backups', async (c) => {
    try {
        // We can just Exec into backup-service
        // The original code executed a shell command inside 'backup-service'.
        // We assume S3_ENDPOINT, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY are available in the container environment.

        const proc = deps.spawn(["docker", "exec", "backup-service", "sh", "-c", "aws --endpoint-url $S3_ENDPOINT s3 ls s3://$BACKUP_BUCKET/"], { stdout: "pipe" });
        const output = await new Response(proc.stdout).text();

        const files = output.trim().split('\n').map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 4) return null;
            return {
                date: `${parts[0]} ${parts[1]}`,
                size: parts[2],
                name: parts.slice(3).join(' ')
            };
        }).filter(Boolean);

        const lang = getLang(c);
        return c.html(<BackupList files={files} lang={lang} />);
    } catch (e) {
        console.error(e);
        return c.html(<BackupList files={[]} lang={getLang(c)} />);
    }
});
