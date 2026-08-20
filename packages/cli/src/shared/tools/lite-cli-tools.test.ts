import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
    buildLiteArgs,
    registerLiteCliTools,
    resolveLiteCommand,
} from "./lite-cli-tools";

describe("SupaCloud Lite CLI adapter", () => {
    test("maps Lite commands without creating a Postgres DSN", () => {
        expect(buildLiteArgs({
            action: "migrate",
            project_dir: "/workspace/project",
            engine: "pglite",
        })).toEqual(["migrate", "--project-dir", "/workspace/project", "--engine", "pglite"]);

        expect(buildLiteArgs({
            action: "db_pull",
            project_dir: "/workspace/project",
            file: "remote_schema",
        })).toEqual(["db", "pull", "remote_schema", "--project-dir", "/workspace/project"]);

        expect(buildLiteArgs({
            action: "snapshot_restore",
            project_dir: "/workspace/project",
            snapshot_file: "/tmp/backup.tar.gz",
            force: true,
        })).toEqual([
            "snapshot", "restore", "/tmp/backup.tar.gz",
            "--project-dir", "/workspace/project", "--force",
        ]);
    });

    test("resolves explicit binaries and rejects unsafe paths", () => {
        expect(resolveLiteCommand("/workspace/project", {
            SUPACLOUD_LITE_CLI_BIN: "/opt/bin/supacloud-lite",
        })).toEqual(["/opt/bin/supacloud-lite"]);
        expect(() => resolveLiteCommand("/workspace/project", {
            SUPACLOUD_LITE_CLI_BIN: "bad\0path",
        })).toThrow("Invalid SUPACLOUD_LITE_CLI_BIN");
    });

    test("keeps Lite actions local and never calls the Management callback", async () => {
        let registered: ((args: any) => Promise<any>) | undefined;
        let request: any;
        registerLiteCliTools({
            tool(_name, _description, _schema, callback) {
                registered = callback;
            },
        }, {
            executeLiteCli: async (value) => {
                request = value;
                return { exitCode: 0, stdout: "ready\n", stderr: "" };
            },
        });

        const result = await registered!({ action: "doctor", project_dir: resolve(".") });

        expect(request).toEqual({ action: "doctor", project_dir: resolve(".") });
        expect(result.isError).toBe(false);
        expect(result.content[0].text).toContain("SupaCloud Lite doctor completed");
    });
});
