import { describe, expect, test } from "bun:test";
import { resolveSupaCloudContext } from "./context";

describe("resolveSupaCloudContext", () => {
    test("infers management URL from custom project API domain", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "https://api.xg.aizhuliren.cn",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("https://studio.xg.aizhuliren.cn");
        expect(context.host).toBe("studio.xg.aizhuliren.cn");
        expect(context.apiToken).toBe("service-role");
    });

    test("infers management URL from managed project API domain", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "https://abc123.api.example.com/",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            SUPACLOUD_PROJECT_REF: "abc123",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("https://studio-abc123.example.com");
        expect(context.projectRef).toBe("abc123");
    });

    test("explicit management API URL wins over Supabase URL inference", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "https://api.xg.aizhuliren.cn",
            SUPACLOUD_API_URL: "https://management.example.com/",
            SUPACLOUD_API_TOKEN: "token",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("https://management.example.com");
        expect(context.apiToken).toBe("token");
    });

    test("invalid placeholder Supabase URL does not throw", () => {
        const context = resolveSupaCloudContext({
            SUPABASE_URL: "{API_URL}",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        }, "/tmp/no-such-supacloud-context");

        expect(context.apiUrl).toBe("");
        expect(context.host).toBe("");
        expect(context.inferredSupabaseUrl).toBe("");
        expect(context.apiToken).toBe("service-role");
    });
});
