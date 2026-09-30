import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runAppTool } from "./app-tools";

const CLI_ENTRY = resolve(import.meta.dir, "../../index.ts");
const roots: string[] = [];
const SOURCE = `import { Injectable, Module } from "./runtime";
@Injectable()
export class AppService { get(): string { return "ok"; } }
@Module({ name: "app", providers: [AppService] })
export class AppModule {}
`;

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "supacloud-dev-regression-"));
    roots.push(root);
    for (const [name, content] of Object.entries({
        "tsconfig.json": JSON.stringify({ compilerOptions: {
            target: "ES2022", module: "ESNext", moduleResolution: "bundler",
            experimentalDecorators: true, strict: true,
        } }),
        "src/runtime.ts": `export function Injectable(_options: unknown = {}): ClassDecorator { return () => {}; }
export function Module(_options: unknown): ClassDecorator { return () => {}; }\n`,
        "src/app.module.ts": SOURCE,
    })) {
        await mkdir(dirname(join(root, name)), { recursive: true });
        await writeFile(join(root, name), content);
    }
    return root;
}

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function spawn(root: string, args: string[], overrides: Record<string, string> = {}) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !/^(SUPACLOUD_|SUPABASE_)/.test(key)) env[key] = value;
    }
    return Bun.spawn([process.execPath, "--no-env-file", CLI_ENTRY, "app", "dev", "--root", root, ...args], {
        cwd: root, env: { ...env, HOME: root, ...overrides }, stdout: "pipe", stderr: "pipe",
    });
}

async function run(root: string, args: string[], env: Record<string, string> = {}) {
    const child = spawn(root, args, env);
    const deadline = setTimeout(() => child.kill("SIGKILL"), 8_000);
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
    } finally { clearTimeout(deadline); }
}

async function until(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(message);
        await Bun.sleep(20);
    }
}

async function collect(stream: ReadableStream<Uint8Array>, accept: (text: string) => void) {
    const decoder = new TextDecoder();
    for await (const bytes of stream) accept(decoder.decode(bytes, { stream: true }));
    accept(decoder.decode());
}

describe("app dev actual CLI regressions", () => {
    test("the documented database-url flag works and never prints credentials", async () => {
        const result = await run(await fixture(), ["--once", "--profile", "integration", "--format", "json",
            "--database-url", "postgresql://user:db-secret@db.example:5432/app?password=query-secret#fragment-secret"]);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).database).toEqual({ mode: "explicit", configured: true, url: "postgresql://db.example:5432/app" });
        expect(result.stdout + result.stderr).not.toMatch(/db-secret|query-secret|fragment-secret/);
    });

    test("fast mode ignores ambient integration database credentials", async () => {
        const result = await run(await fixture(), ["--once", "--format", "json"], {
            SUPACLOUD_DEV_DATABASE_URL: "postgresql://user:ambient-secret@private-host/app",
        });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).database).toEqual({ mode: "local", configured: false, url: null });
        expect(result.stdout + result.stderr).not.toMatch(/ambient-secret|private-host/);
    });

    for (const url of ["data:text/plain,private-uri-secret", "file:///private-uri-secret", "postgresql:///private-uri-secret", "not-a-url-private-uri-secret"]) {
        test(`integration refuses malformed or unsupported database URL (${url.split(":")[0]})`, async () => {
            const result = await run(await fixture(), ["--once", "--profile", "integration", "--format", "json", "--database_url", url]);
            expect(result.exitCode).toBe(1);
            expect(result.stdout + result.stderr).not.toContain("private-uri-secret");
        });
    }

    test("database flag aliases cannot silently override each other", async () => {
        const result = await run(await fixture(), ["--once", "--profile", "integration",
            "--database_url", "postgresql://db.example/app", "--database-url", "postgresql://other.example/app"]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).toContain("Do not combine");
    });

    test("fast mode refuses an explicit database instead of claiming to use it", async () => {
        const result = await run(await fixture(), ["--once", "--database_url", "postgresql://user:fast-secret@db.example/app"]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).not.toContain("fast-secret");
    });

    test("a failed current compile does not report modules from retained old artifacts", async () => {
        const root = await fixture();
        const success = await run(root, ["--once", "--format", "json"]);
        expect(success.exitCode).toBe(0);
        const outDir = JSON.parse(success.stdout).outDir;
        const oldManifest = await readFile(join(outDir, "app.manifest.json"), "utf8");
        await writeFile(join(root, "src/app.module.ts"), SOURCE.replace("providers: [AppService]", "providers: [MissingService]"));
        const failure = await run(root, ["--once", "--format", "json"]);
        expect(failure.exitCode).toBe(1);
        expect(JSON.parse(failure.stdout)).toMatchObject({ ok: false, modules: [], written: [], artifacts: "not-current" });
        expect(await readFile(join(outDir, "app.manifest.json"), "utf8")).toBe(oldManifest);
    }, 15_000);

    test("integration accepts the dedicated environment URL", async () => {
        const result = await run(await fixture(), ["--once", "--profile", "integration", "--format", "json"], {
            SUPACLOUD_DEV_DATABASE_URL: "postgres://user:environment-secret@env.example/app",
        });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).database.url).toBe("postgres://env.example/app");
        expect(result.stdout + result.stderr).not.toContain("environment-secret");
    });

    test("explicit integration URL takes precedence over the environment", async () => {
        const result = await run(await fixture(), ["--once", "--profile", "integration", "--format", "json",
            "--database-url", "postgresql://explicit.example/app"], {
            SUPACLOUD_DEV_DATABASE_URL: "postgresql://user:environment-secret@env.example/app",
        });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).database.url).toBe("postgresql://explicit.example/app");
        expect(result.stdout + result.stderr).not.toMatch(/environment-secret|env.example/);
    });

    test("an empty explicit URL does not fall back to the environment", async () => {
        const result = await run(await fixture(), ["--once", "--profile", "integration", "--database-url", ""], {
            SUPACLOUD_DEV_DATABASE_URL: "postgresql://user:environment-secret@env.example/app",
        });
        expect(result.exitCode).toBe(1);
        expect(result.stdout + result.stderr).not.toMatch(/environment-secret|env.example/);
    });

    test("embedded progress can cancel a live watcher and removes signal handlers", async () => {
        const root = await fixture();
        const abort = new AbortController();
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
        const progress: string[] = [];
        const result = await runAppTool({ action: "dev", root }, {
            signal: abort.signal,
            onDevProgress(report) { progress.push(report.content[0]!.text); abort.abort(); },
        });
        expect(progress).toHaveLength(1);
        expect(progress[0]).toContain("Watching for changes");
        expect(result.content[0]!.text).toContain("Watch stopped.");
        expect(result.content[0]!.text).not.toContain("Press Ctrl+C");
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    });

    test("progress transport failure closes the watcher and removes signal handlers", async () => {
        const root = await fixture();
        const failure = new Error("progress transport unavailable");
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
        await expect(runAppTool({ action: "dev", root }, {
            onDevProgress() { throw failure; },
        })).rejects.toBe(failure);
        expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    });

    test("watch reports initial, error and repaired builds before shutdown; stdout stays one JSON document", async () => {
        const root = await fixture();
        const child = spawn(root, ["--format", "json"]);
        let stdout = "";
        let stderr = "";
        const output = collect(child.stdout, text => { stdout += text; });
        const errors = collect(child.stderr, text => { stderr += text; });
        const reports = () => stderr.split("\n").filter(line => line.startsWith("{")).flatMap(line => {
            try { return [JSON.parse(line)]; } catch { return []; }
        });
        let completed = false;
        void child.exited.then(() => { completed = true; });
        try {
            await until(() => reports().some(report => report.state === "watching" && report.ok), "no initial watch report before shutdown");
            expect(completed).toBe(false);
            expect(stdout).toBe("");
            await writeFile(join(root, "src/app.module.ts"), SOURCE.replace("providers: [AppService]", "providers: [MissingService]"));
            await until(() => reports().some(report => report.ok === false), "failed rebuild was not reported");
            const count = reports().length;
            await writeFile(join(root, "src/app.module.ts"), SOURCE);
            await until(() => reports().length > count && reports().at(-1)?.ok === true, "repaired rebuild was not reported");
            child.kill("SIGTERM");
            await until(() => completed, "watch did not stop after SIGTERM");
            await Promise.all([output, errors]);
            expect(await child.exited).toBe(0);
            expect(JSON.parse(stdout)).toMatchObject({ ok: true, state: "stopped", watch: true, modules: ["app"] });
        } finally {
            if (!completed) child.kill("SIGKILL");
            await Promise.all([child.exited, output, errors]);
        }
    }, 20_000);
});
