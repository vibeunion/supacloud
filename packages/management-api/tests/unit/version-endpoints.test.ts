import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import pkg from "../../package.json";

const app = new Elysia()
  .get("/version", () => ({
    version: pkg.version || "unknown",
    environment: process.env.NODE_ENV || "production",
    api_version: "2024-01-01",
  }))
  .get("/v1/version", () => ({
    version: pkg.version || "unknown",
    environment: process.env.NODE_ENV || "production",
    api_version: "2024-01-01",
  }));

describe("public version routes", () => {
  test("GET /version returns package version and environment", async () => {
    const res = await app.handle(new Request("http://localhost/version"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.version).toBe(pkg.version);
    expect(body.api_version).toBe("2024-01-01");
    expect(body.environment).toBeTruthy();
  });

  test("GET /v1/version returns package version and environment", async () => {
    const res = await app.handle(new Request("http://localhost/v1/version"));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.version).toBe(pkg.version);
    expect(body.api_version).toBe("2024-01-01");
    expect(body.environment).toBeTruthy();
  });
});
