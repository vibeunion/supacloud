import { describe, expect, test } from "bun:test";
import { createAdminTools } from "./index";

const baseContext = {
    host: "server.example.com",
    sshUser: "root",
    sshPort: 22,
    sshKey: "",
    sshPass: "secret-password",
    sshHostFingerprint: "",
    apiUrl: "https://studio.example.com",
    apiToken: "api-token",
    projectRef: "",
    readOnly: false,
    inferredSupabaseUrl: "",
    inferredServiceRoleKey: "",
    source: "env" as const,
};

describe("admin SSH registration gate", () => {
    test("does not register executable SSH tools without a verified host fingerprint", () => {
        const tools = createAdminTools(baseContext);
        expect(tools.project.schema.name).toBeDefined();
        expect(tools.ssh.schema.command).toBeUndefined();
        return tools.ssh.callback({ action: "ping" }).then((result) => {
            expect(result.content[0]?.text).toContain("SUPACLOUD_SSH_HOST_FINGERPRINT");
        });
    });

    test("registers SSH tools only when the fingerprint is configured", () => {
        const tools = createAdminTools({
            ...baseContext,
            sshHostFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        });
        expect(tools.ssh.schema.command).toBeDefined();
    });
});
