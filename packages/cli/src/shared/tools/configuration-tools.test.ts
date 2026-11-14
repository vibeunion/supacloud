import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __internal, readSecretGap, registerConfigurationTools } from "./configuration-tools";
import { syncEnvironmentProfile } from "./configuration-tools";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "supacloud-config-"));
    temporaryDirectories.push(path);
    return path;
}

describe("configuration automation", () => {
    test("derives public and internal values without exposing secrets", () => {
        const values = __internal.derivedValues({
            SUPABASE_PUBLIC_DOMAIN: "api.example.com",
            SUPACLOUD_HOST: "127.0.0.1",
        });
        expect(values).toMatchObject({
            SUPABASE_STUDIO_DOMAIN: "studio.example.com",
            SUPABASE_PUBLIC_URL: "https://api.example.com",
            SUPACLOUD_API_URL: "http://127.0.0.1:9090",
            SUPACLOUD_DEPLOYMENT_PROFILE: "solo",
            S3_STORAGE_TYPE: "juicefs",
        });
        const entries = __internal.configurationEntries({ API_TOKEN: "secret-value" });
        expect(entries.find(entry => entry.name === "API_TOKEN")?.value).toBe("********");
    });

    test("onboarding plan and sync keep secret values out of generated config", async () => {
        const root = await workspace();
        await writeFile(join(root, "supacloud.json"), JSON.stringify({ frontend: { root: "." } }) + "\n");
        await writeFile(join(root, ".env.supacloud.test"), [
            "SUPACLOUD_ENV=test",
            "SUPACLOUD_API_URL=https://management.example.com",
            "SUPACLOUD_API_TOKEN=do-not-copy",
            "SUPACLOUD_PROJECT_REF=abc123",
            "API_SECRET=also-do-not-copy",
            "VITE_PUBLIC_FLAG=on",
            "",
        ].join("\n"));

        const result = await syncEnvironmentProfile({ root, environment: "test", write: true }, { cwd: root });
        expect(result.content[0].text).not.toContain("do-not-copy");
        expect(result.content[0].text).not.toContain("also-do-not-copy");
        const config = JSON.parse(await readFile(join(root, "supacloud.json"), "utf8")) as {
            context: { environments: { test: Record<string, unknown> } };
        };
        expect(config.context.environments.test).toMatchObject({
            api_url: "https://management.example.com",
            project_ref: "abc123",
            secret_names: expect.arrayContaining(["API_SECRET", "SUPACLOUD_API_TOKEN"]),
        });
        expect(config.context.environments.test.public).toEqual({ VITE_PUBLIC_FLAG: "on" });
        expect(await readFile(join(root, ".env.supacloud.test.example"), "utf8"))
            .toBe("SUPACLOUD_ENV=test\nSUPACLOUD_API_TOKEN=<inject-at-runtime>\n");
    });

    test("configuration tools expose doctor and explain as structured local commands", async () => {
        const root = await workspace();
        await writeFile(join(root, "supacloud.json"), JSON.stringify({
            context: { environments: { test: { api_url: "https://management.example.com", project_ref: "abc123" } } },
        }) + "\n");
        const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
        registerConfigurationTools({ tool(name, _description, _schema, callback) { tools.set(name, callback as never); } }, {
            cwd: root,
            activeContext: {
                environment: "test",
                production: false,
            } as never,
        });
        const doctor = await tools.get("config")!({ action: "doctor", root, format: "json" });
        expect(JSON.parse(doctor.content[0].text)).toMatchObject({ schema: "supacloud.configuration.doctor.v1", environment: "test" });
    });

    test("configuration doctor fails closed when no required context is configured", async () => {
        const root = await workspace();
        await writeFile(join(root, "supacloud.json"), "{}\n");
        const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
        registerConfigurationTools({ tool(name, _description, _schema, callback) { tools.set(name, callback as never); } }, { cwd: root });
        const doctor = await tools.get("config")!({ action: "doctor", root, format: "json" });
        expect(doctor.isError).toBe(true);
        expect(JSON.parse(doctor.content[0].text)).toMatchObject({
            ok: false,
            missing: ["SUPACLOUD_API_TOKEN", "SUPACLOUD_API_URL", "SUPACLOUD_PROJECT_REF"],
        });
    });

    test("secret gap inspection reports names without reading values into output", async () => {
        const root = await workspace();
        await writeFile(join(root, "supacloud.json"), JSON.stringify({
            context: { environments: { test: { secret_names: ["API_KEY", "WEBHOOK_SECRET"] } } },
        }) + "\n");
        await writeFile(join(root, ".env.supacloud.test"), "SUPACLOUD_ENV=test\nAPI_KEY=present-value\n");
        await expect(readSecretGap(root, "test")).resolves.toEqual({
            environment: "test",
            required: ["API_KEY", "WEBHOOK_SECRET"],
            present: ["API_KEY"],
            missing: ["WEBHOOK_SECRET"],
        });
    });
});
