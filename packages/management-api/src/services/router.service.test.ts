import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { RouterService } from "./router.service";
import fs from "node:fs/promises";
import { shellService } from "./shell.service";
import { config } from "../config";

describe("RouterService", () => {
    let routerService: RouterService;

    beforeEach(() => {
        mock.restore();

        // Override config values for predictable test behavior
        Object.defineProperty(config, "angieSitesDir", { value: "/tmp/angie_test_sites", writable: true, configurable: true });
        Object.defineProperty(config, "kongInternal", { value: "127.0.0.1:8000", writable: true, configurable: true });
        Object.defineProperty(config, "baseDomain", { value: "test.domain", writable: true, configurable: true });
        Object.defineProperty(config, "acmeClient", { value: "le", writable: true, configurable: true });

        spyOn(fs, "mkdir").mockImplementation(() => Promise.resolve(undefined));
        spyOn(fs, "writeFile").mockImplementation(() => Promise.resolve());
        spyOn(fs, "unlink").mockImplementation(() => Promise.resolve());

        spyOn(shellService, "executeCommand").mockImplementation(() =>
            Promise.resolve({ success: true, output: "mocked success" })
        );
    });

    it("should generate correct config with ENABLE_SSL=true", async () => {
        Object.defineProperty(config, "enableSsl", { value: true, writable: true, configurable: true });
        routerService = new RouterService();

        const projectRef = "test-project-1";
        await routerService.addRoute(projectRef);

        expect(fs.writeFile).toHaveBeenCalled();
        const callArgs = (fs.writeFile as ReturnType<typeof mock>).mock.calls[0];
        const writtenConfig = callArgs[1] as string;

        expect(writtenConfig).toContain("acme le;");
        expect(writtenConfig).toContain("ssl_certificate $acme_cert_le;");
        expect(writtenConfig).toContain("ssl_certificate_key $acme_cert_key_le;");
        expect(writtenConfig).toContain("listen 443 ssl;");
    });

    it("should generate correct config with ENABLE_SSL=false", async () => {
        Object.defineProperty(config, "enableSsl", { value: false, writable: true, configurable: true });
        routerService = new RouterService();

        const projectRef = "test-project-2";
        await routerService.addRoute(projectRef);

        expect(fs.writeFile).toHaveBeenCalled();
        const callArgs = (fs.writeFile as ReturnType<typeof mock>).mock.calls[0];
        const writtenConfig = callArgs[1] as string;

        expect(writtenConfig).not.toContain("acme le;");
        expect(writtenConfig).not.toContain("ssl_certificate $acme_cert_le;");
        expect(writtenConfig).not.toContain("listen 443 ssl;");
        expect(writtenConfig).toContain("listen 80;");
    });

    it("should generate correct config for custom domain with ENABLE_SSL=true", async () => {
        Object.defineProperty(config, "enableSsl", { value: true, writable: true, configurable: true });
        routerService = new RouterService();

        const projectRef = "test-project-3";
        const customDomain = "custom.example.com";
        await routerService.bindCustomDomain(projectRef, customDomain);

        expect(fs.writeFile).toHaveBeenCalled();
        const callArgs = (fs.writeFile as ReturnType<typeof mock>).mock.calls[0];
        const writtenConfig = callArgs[1] as string;

        expect(writtenConfig).toContain(`server_name ${customDomain};`);
        expect(writtenConfig).toContain("acme le;");
        expect(writtenConfig).toContain("ssl_certificate $acme_cert_le;");
        expect(writtenConfig).toContain("ssl_certificate_key $acme_cert_key_le;");
        expect(writtenConfig).toContain("listen 443 ssl;");
    });
});
