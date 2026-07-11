import { describe, expect, test } from "bun:test";

import { resolveSupaCloudContext } from "./context";

describe("admin SSH context", () => {
    test("reads the explicit host fingerprint without inferring an insecure default", () => {
        const empty = resolveSupaCloudContext({ SUPACLOUD_HOST: "server.example.com" }, "/nonexistent");
        expect(empty.sshHostFingerprint).toBe("");

        const configured = resolveSupaCloudContext({
            SUPACLOUD_HOST: "server.example.com",
            SUPACLOUD_SSH_HOST_FINGERPRINT: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        }, "/nonexistent");
        expect(configured.sshHostFingerprint).toBe("SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    });
});
