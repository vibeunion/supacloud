import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { registerRemoteDevTools } from "./remote-dev-tools";

describe("remote dev tools", () => {
    test("syncs through mkdir, rsync, and reload without shell execution", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-dev-"));
        await mkdir(join(root, "supabase", "functions", "api"), { recursive: true });
        await writeFile(join(root, "supabase", "functions", "api", "index.ts"), "export default {}\n");
        const calls: Array<{ command: string; args: string[] }> = [];
        let index = 0;
        let tool: ((args: any) => Promise<any>) | undefined;
        registerRemoteDevTools({ tool(_name, _description, _schema, handler) { tool = handler; } }, {
            cwd: root,
            host: "test.example.com",
            sshUser: "deploy",
            sshPort: 22,
            sshKey: "/tmp/test-key",
            projectRef: "test-project",
            environment: "test",
            execute: async (command, args) => {
                calls.push({ command, args });
                index += 1;
                return { exitCode: 0, stdout: index === 3 ? "reloaded" : "", stderr: "" };
            },
        });
        const response = await tool!({ action: "sync", target: "functions", function: "api", project_dir: root });
        expect(response.isError).not.toBe(true);
        expect(calls.map((call) => call.command)).toEqual(["ssh", "rsync", "ssh"]);
        expect(calls[1].args).not.toContain("sh");
        expect(calls[1].args).toContain("--checksum");
    });

    test("rejects production before starting a remote process", async () => {
        let tool: ((args: any) => Promise<any>) | undefined;
        registerRemoteDevTools({ tool(_name, _description, _schema, handler) { tool = handler; } }, {
            host: "test.example.com",
            sshUser: "deploy",
            sshKey: "/tmp/test-key",
            projectRef: "prod-project",
            environment: "production",
            execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        });
        await expect(tool!({ action: "status" })).rejects.toThrow("forbidden for production");
    });

    test("generates Drizzle migrations and previews SupaCloud apply without writing by default", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-drizzle-"));
        await writeFile(join(root, "drizzle.config.ts"), "export default {}\n");
        const commands: string[] = [];
        const databaseCalls: any[] = [];
        let tool: ((args: any) => Promise<any>) | undefined;
        registerRemoteDevTools({ tool(_name, _description, _schema, handler) { tool = handler; } }, {
            cwd: root,
            projectRef: "test-project",
            environment: "test",
            execute: async (command) => {
                commands.push(command);
                return { exitCode: 0, stdout: "generated", stderr: "" };
            },
            runDatabase: async (args) => {
                databaseCalls.push(args);
                return { content: [{ type: "text", text: "dry-run ok" }] };
            },
        });
        const response = await tool!({ action: "migrate", project_dir: root });
        expect(response.isError).not.toBe(true);
        expect(commands).toEqual(["drizzle-kit"]);
        expect(databaseCalls).toEqual([{ action: "push_migrations", dir: "supabase/migrations", dry_run: true, strict: true }]);
        expect(response.content[0].text).toContain('"applied": false');
    });
});
