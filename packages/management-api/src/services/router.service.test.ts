import { describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { RouterService } from "./router.service";
import fs from "node:fs/promises";
import path from "node:path";
import { shellService } from "./shell.service";

describe("RouterService", () => {
    let routerService: RouterService;

    beforeEach(() => {
        // 设置环境变量，以防真实环境的干扰
        process.env.ANGIE_SITES_DIR = "/tmp/angie_test_sites";
        process.env.KONG_INTERNAL = "127.0.0.1:8000";
        process.env.BASE_DOMAIN = "test.domain";
        process.env.ACME_CLIENT = "le";

        // 初始化服务
        routerService = new RouterService();

        // 每次跑之前清理掉 fs 和 shellService 的 mock 记录
        mock.restore();

        spyOn(fs, "mkdir").mockImplementation(() => Promise.resolve(undefined));
        spyOn(fs, "writeFile").mockImplementation(() => Promise.resolve());
        spyOn(fs, "unlink").mockImplementation(() => Promise.resolve());

        spyOn(shellService, "executeCommand").mockImplementation(() =>
            Promise.resolve({ success: true, output: "mocked success" })
        );
    });

    it("should generate correct config with ENABLE_SSL=true", async () => {
        process.env.ENABLE_SSL = "true";
        routerService = new RouterService();

        const projectRef = "test-project-1";
        await routerService.addRoute(projectRef);

        expect(fs.writeFile).toHaveBeenCalled();
        const callArgs = (fs.writeFile as ReturnType<typeof mock>).mock.calls[0];
        const writtenConfig = callArgs[1] as string;

        // 验证 ACME 相关的配置
        expect(writtenConfig).toContain("acme le;");
        expect(writtenConfig).toContain("ssl_certificate $acme_cert_le;");
        expect(writtenConfig).toContain("ssl_certificate_key $acme_cert_key_le;");
        expect(writtenConfig).toContain("listen 443 ssl;");
    });

    it("should generate correct config with ENABLE_SSL=false", async () => {
        process.env.ENABLE_SSL = "false";
        routerService = new RouterService();

        const projectRef = "test-project-2";
        await routerService.addRoute(projectRef);

        expect(fs.writeFile).toHaveBeenCalled();
        const callArgs = (fs.writeFile as ReturnType<typeof mock>).mock.calls[0];
        const writtenConfig = callArgs[1] as string;

        // 验证非 SSL 配置
        expect(writtenConfig).not.toContain("acme le;");
        expect(writtenConfig).not.toContain("ssl_certificate $acme_cert_le;");
        expect(writtenConfig).not.toContain("listen 443 ssl;");
        expect(writtenConfig).toContain("listen 80;");
    });

    it("should generate correct config for custom domain with ENABLE_SSL=true", async () => {
        process.env.ENABLE_SSL = "true";
        routerService = new RouterService();

        const projectRef = "test-project-3";
        const customDomain = "custom.example.com";
        await routerService.addCustomDomain(projectRef, customDomain);

        expect(fs.writeFile).toHaveBeenCalled();
        const callArgs = (fs.writeFile as ReturnType<typeof mock>).mock.calls[0];
        const writtenConfig = callArgs[1] as string;

        // 验证自定义域名的 ACME 配置
        expect(writtenConfig).toContain(`server_name ${customDomain};`);
        expect(writtenConfig).toContain("acme le;");
        expect(writtenConfig).toContain("ssl_certificate $acme_cert_le;");
        expect(writtenConfig).toContain("ssl_certificate_key $acme_cert_key_le;");
        expect(writtenConfig).toContain("listen 443 ssl;");
    });
});
