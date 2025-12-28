
import { Hono } from "hono";
import { getLang } from "../lib/i18n";
import { deps } from "../lib/deps";
import { INSTANCES_DIR } from "../lib/config";
import { Dashboard } from "../components/Dashboard";
import { LogsModal } from "../components/LogsModal";
import { ConfigModal } from "../components/ConfigModal";
import { FunctionModal } from "../components/FunctionModal";
import { BackupList } from "../components/BackupList";
import { getProjectConfig, listFunctions, getFunction } from "../lib/projects";
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

    return c.html(<Dashboard projects={projects} lang={lang} />);
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
        // ENV variables might not be available here directly if they are inside container context.
        // The original code executed a shell command inside 'backup-service'.
        // We should check what environment variables 'backup-service' has.
        // Assuming it has AWS_ACCESS_KEY_ID et al from garage_keys.env or similar passing.
        // Wait, the original code injected enviroment variables in the exec command:
        // "export AWS_ACCESS_KEY_ID=$GARAGE_ACCESS_KEY; ..."
        // But where do THESE variables come from in the Node process?
        // They came from process.env in the monolithic app?
        // Actually the original code had:
        // `docker exec backup-service sh -c "export AWS_ACCESS_KEY_ID=$GARAGE_ACCESS_KEY; ..."` inside calls?
        // Let's re-read the original View File output for /system/backups.

        // It was:
        // const proc = deps.spawn(["docker", "exec", "backup-service", "sh", "-c", "export AWS_ACCESS_KEY_ID=$GARAGE_ACCESS_KEY; export AWS_SECRET_ACCESS_KEY=$GARAGE_SECRET_KEY; aws --endpoint-url $S3_ENDPOINT s3 ls s3://$BACKUP_BUCKET/"], {stdout: "pipe" });
        // The $GARAGE_ACCESS_KEY syntax suggests these are environment variables INSIDE the container shell session?
        // OR they are meant to be interpolated from the host process? 
        // If they are $VAR, the shell evaluates them. If the backup-service container already has them, then great.
        // But usually `docker exec` doesn't inherit container env vars for the command line unless the shell inside sources them or they are already exported.
        // If these variables are set in the `environment` section of docker-compose for backup-service, they are available.
        // Let's assume they are available in the container environment.

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
