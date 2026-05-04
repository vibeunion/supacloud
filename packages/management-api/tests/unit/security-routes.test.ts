import { describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { securityRoutes } from "../../src/routes/security";
import { shellService } from "../../src/services/shell.service";

const app = new Elysia().use(securityRoutes);

function request(path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("security routes", () => {
  test("rejects invalid firewall input before invoking shell", async () => {
    const shellSpy = spyOn(shellService, "execute").mockResolvedValue({
      success: true,
      output: "",
      error: "",
    });

    const res = await request("/v1/security/firewall/allow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dev-master-token",
      },
      body: JSON.stringify({ port: 5432, ip: "127.0.0.1; touch /tmp/pwned" }),
    });

    expect(res.status).toBe(400);
    expect(shellSpy).not.toHaveBeenCalled();
    shellSpy.mockRestore();
  });

  test("allows valid cidr firewall input", async () => {
    const shellSpy = spyOn(shellService, "execute").mockResolvedValue({
      success: true,
      output: "",
      error: "",
    });

    const res = await request("/v1/security/firewall/allow", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dev-master-token",
      },
      body: JSON.stringify({ port: 5432, ip: "192.0.2.0/24" }),
    });

    expect(res.status).toBe(200);
    expect(shellSpy).toHaveBeenCalledWith("security_manager.sh", ["add_firewall_rule", "5432", "192.0.2.0/24"]);
    shellSpy.mockRestore();
  });

  test("rejects invalid ssl domain before invoking shell", async () => {
    const shellSpy = spyOn(shellService, "execute").mockResolvedValue({
      success: true,
      output: "",
      error: "",
    });

    const res = await request("/v1/security/ssl/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dev-master-token",
      },
      body: JSON.stringify({ domain: "example.com; rm -rf /" }),
    });

    expect(res.status).toBe(400);
    expect(shellSpy).not.toHaveBeenCalled();
    shellSpy.mockRestore();
  });
});
