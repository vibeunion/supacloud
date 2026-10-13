import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerDeveloperExperienceTools } from "./developer-experience-tools";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function register() {
    const tools = new Map<string, (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>>();
    registerDeveloperExperienceTools({
        tool(name, _description, _schema, callback) {
            tools.set(name, callback);
        },
    });
    return tools;
}

async function workspace(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "supacloud-dx-"));
    temporaryDirectories.push(directory);
    return directory;
}

describe("developer experience tools", () => {
    test("init creates Web build config and requires application binding in profile examples", async () => {
        const root = await workspace();
        await writeFile(join(root, "package.json"), JSON.stringify({
            scripts: { build: "vite build" },
            devDependencies: { vite: "^7.0.0" },
        }));

        const response = await register().get("init")!({ root });

        expect(response.isError).not.toBe(true);
        expect(JSON.parse(await readFile(join(root, "supacloud.json"), "utf8"))).toEqual({
            frontend: { root: ".", outputDirectory: "dist" },
        });
        expect(await readFile(join(root, ".env.supacloud.test.example"), "utf8"))
            .toContain("SUPACLOUD_API_TOKEN=<test-management-api-token>");
        expect(await readFile(join(root, ".gitignore"), "utf8"))
            .toContain(".env.supacloud.*");
        expect(response.content[0].text).toContain("supacloud env check");
        expect(response.content[0].text).toContain("SUPACLOUD_APPLICATION_ID");
    });

    test("init never overwrites existing deployment configuration", async () => {
        const root = await workspace();
        await writeFile(join(root, "supacloud.json"), "{}\n");

        await expect(register().get("init")!({ root })).rejects.toThrow("never overwrites");
        expect(await readFile(join(root, "supacloud.json"), "utf8")).toBe("{}\n");
    });

    test("env list does not expose profile values", async () => {
        const root = await workspace();
        await writeFile(join(root, ".env.supacloud.test"), [
            "SUPACLOUD_ENV=test",
            "SUPACLOUD_API_URL=https://management.test.example.com",
            "SUPACLOUD_API_TOKEN=secret-token",
            "SUPACLOUD_PROJECT_REF=test-ref",
            "",
        ].join("\n"));

        const response = await register().get("env")!({ action: "list", root });

        expect(response.content[0].text).toContain("test");
        expect(response.content[0].text).not.toContain("secret-token");
        expect(response.content[0].text).not.toContain("test-ref");
    });

    test("env check reports ready and incomplete profiles without contacting a server", async () => {
        const root = await workspace();
        await writeFile(join(root, ".env.supacloud.test"), [
            "SUPACLOUD_ENV=test",
            "SUPACLOUD_API_URL=https://management.test.example.com",
            "SUPACLOUD_API_TOKEN=secret-token",
            "SUPACLOUD_PROJECT_REF=test-ref",
            "",
        ].join("\n"));
        await writeFile(join(root, ".env.supacloud.production"), [
            "SUPACLOUD_ENV=production",
            "SUPACLOUD_API_URL=https://management.example.com",
            "SUPACLOUD_PROJECT_REF=prod-ref",
            "",
        ].join("\n"));

        const response = await register().get("env")!({ action: "check", root, json: true });
        const result = JSON.parse(response.content[0].text) as {
            ok: boolean;
            environments: Array<{ name: string; statusReady: boolean; statusMissing: string[]; projectRef: string | null }>;
        };

        expect(response.isError).toBe(true);
        expect(result.ok).toBe(false);
        expect(result.environments).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: "test", statusReady: true, projectRef: "test-ref" }),
            expect.objectContaining({
                name: "production",
                statusReady: false,
                statusMissing: ["SUPACLOUD_API_TOKEN"],
                projectRef: "prod-ref",
            }),
        ]));
    });
});
