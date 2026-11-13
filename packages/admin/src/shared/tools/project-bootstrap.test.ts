import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readProjectBootstrapSpec, summarizeBootstrapTasks, waitForBootstrap } from "./project-bootstrap";

describe("project bootstrap automation", () => {
    test("reads JSON and simple YAML without introducing secret fields", async () => {
        const root = await mkdtemp(join(tmpdir(), "supacloud-bootstrap-"));
        try {
            const path = join(root, "supacloud.yaml");
            await writeFile(path, "name: orders\nregion: local\ndomain: example.com\n");
            await expect(readProjectBootstrapSpec(path)).resolves.toEqual({
                name: "orders",
                region: "local",
                domain: "example.com",
                api_domain: undefined,
                auth_domain: undefined,
                studio_domain: undefined,
                organization_id: undefined,
                environment: undefined,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("summarizes a provisioning saga and stops waiting on terminal state", async () => {
        const tasks = [
            { id: "db", task_type: "provision_db", status: "succeeded" },
            { id: "runtime", task_type: "provision_runtime", status: "failed", error: "unavailable" },
            { id: "cleanup", task_type: "cleanup_db", status: "succeeded" },
        ];
        expect(summarizeBootstrapTasks(tasks)).toMatchObject({ total: 2, succeeded: 1, failed: 1, status: "failed" });

        const calls: string[] = [];
        const http = {
            async get() {
                calls.push("get");
                return { ok: true, status: 200, data: [{ task_type: "provision_db", status: "succeeded" }] };
            },
        } as never;
        const result = await waitForBootstrap(http, "abc", 100, async () => { calls.push("sleep"); });
        expect(result).toHaveLength(1);
        expect(calls).toEqual(["get"]);
    });
});
