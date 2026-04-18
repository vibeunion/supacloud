import { describe, test, expect, beforeEach } from "bun:test";
import { RouterService } from "../../src/services/router.service";
import { config } from "../../src/config";

describe("RouterService", () => {
  let routerService: RouterService;

  beforeEach(() => {
    routerService = new RouterService();
  });

  describe("addRoute", () => {
    test("should return result object", async () => {
      const result = await routerService.addRoute("testref");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });

    test("should accept custom domain", async () => {
      const result = await routerService.addRoute("testref", { apiDomain: "api.custom.example.com", studioDomain: "studio.custom.example.com" });
      expect(result).toHaveProperty("success");
    });
  });

  describe("removeRoute", () => {
    test("should return result object", async () => {
      const result = await routerService.removeRoute("testref");
      expect(result).toHaveProperty("success");
      expect(typeof result.success).toBe("boolean");
    });
  });



  describe("getProjectDomain", () => {
    test("should return formatted domain", () => {
      const domain = routerService.getProjectDomain("testref");
      expect(domain).toBe(`testref.${config.baseDomain}`);
    });

    test("should include project ref in domain", () => {
      const domain = routerService.getProjectDomain("myproject");
      expect(domain).toContain("myproject");
    });
  });

  describe("getProjectApiUrl", () => {
    test("should return HTTPS URL", () => {
      const url = routerService.getProjectApiUrl("testref");
      expect(url.startsWith("https://")).toBe(true);
    });

    test("should include api subdomain", () => {
      const url = routerService.getProjectApiUrl("testref");
      expect(url).toContain(".api.");
    });

    test("should include project ref", () => {
      const url = routerService.getProjectApiUrl("myproject");
      expect(url).toContain("myproject");
    });
  });
});
