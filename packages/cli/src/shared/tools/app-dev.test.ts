import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionMode } from "../execution-policy";
import { registerAppTools, type AppToolArguments } from "./app-tools";

type AppCallback = (args: Partial<AppToolArguments>) => Promise<{
    isError: boolean;
    content: Array<{ type: "text"; text: string }>;
}>;

const abort = new AbortController();
abort.abort();

function captureAppCallback(): AppCallback {
    let callback: AppCallback | undefined;
    registerAppTools(
        {
            tool(_name, _description, _schema, registered) {
                callback = registered as AppCallback;
            },
        },
        { signal: abort.signal },
    );
    if (!callback) throw new Error("app tool was not registered");
    return callback;
}

const FIXTURE_FILES: Record<string, string> = {
    "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "paths": { "@supacloud/app": ["./src/runtime.ts"] },
    "experimentalDecorators": true,
    "strict": true
  }
}
`,
    "src/runtime.ts": `export function Injectable(_options: Record<string, unknown> = {}): ClassDecorator { return () => {}; }
export function Module(_options: Record<string, unknown>): ClassDecorator { return () => {}; }
`,
    "src/app.module.ts": `import { Injectable, Module } from "./runtime";

@Injectable()
export class AppService {
  get(): string { return "ok"; }
}

@Module({ name: "app", providers: [AppService] })
export class AppModule {}
`,
};

describe("app dev", () => {
    let root: string;
    const app = captureAppCallback();

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), "supacloud-app-dev-"));
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
            const absolute = join(root, relativePath);
            await mkdir(dirname(absolute), { recursive: true });
            await writeFile(absolute, content, "utf8");
        }
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    test("fast profile runs one validation pass and reports a local database", async () => {
        const result = await app({ action: "dev", root, once: true, format: "json" });
        expect(result.isError).toBe(false);
        const report = JSON.parse(result.content[0]!.text);
        expect(report).toMatchObject({
            version: 1,
            ok: true,
            profile: "fast",
            watch: false,
            database: { mode: "local", configured: false, url: null },
        });
        expect(report.modules).toContain("app");
        expect(report.written.length).toBeGreaterThan(0);
        expect(report.notVerified.length).toBeGreaterThan(0);
    });

    test("watch mode keeps running until the caller aborts", async () => {
        const result = await app({ action: "dev", root, format: "json" });
        expect(result.isError).toBe(false);
        const report = JSON.parse(result.content[0]!.text);
        expect(report.watch).toBe(true);
        expect(report.profile).toBe("fast");
    });

    test("integration profile refuses to run without an explicit database URL", async () => {
        await expect(app({ action: "dev", root, profile: "integration", once: true }))
            .rejects.toMatchObject({ code: "SCAFFOLD_OPTION_INVALID" });
    });

    test("integration profile reports a redacted explicit database URL", async () => {
        const result = await app({
            action: "dev",
            root,
            profile: "integration",
            once: true,
            format: "json",
            database_url: "postgresql://user:secret@db.example.com:5432/app",
        });
        expect(result.isError).toBe(false);
        const report = JSON.parse(result.content[0]!.text);
        expect(report.database).toEqual({
            mode: "explicit",
            configured: true,
            url: "postgresql://db.example.com:5432/app",
        });
        expect(result.content[0]!.text).not.toContain("secret");
    });

    test("an unknown profile is rejected", async () => {
        await expect(app({ action: "dev", root, profile: "staging" as never, once: true }))
            .rejects.toMatchObject({ code: "SCAFFOLD_OPTION_INVALID" });
    });

    test("app dev is classified as a local execution", () => {
        expect(executionMode("app", "dev", {})).toBe("local");
    });
});