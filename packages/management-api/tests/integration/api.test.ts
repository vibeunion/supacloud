import { describe, test, expect } from "bun:test";
import { Elysia, t } from "elysia";
import { config } from "../../src/config";

// 简化测试 - 只测试认证中间件逻辑
const AUTH_HEADER = { Authorization: `Bearer ${config.masterToken}` };
const INVALID_TOKEN_HEADER = { Authorization: "Bearer invalid-token" };
const BASIC_HEADER = { Authorization: "Basic dXNlcjpwYXNz" };

// 创建最小测试 app（无数据库依赖）
const testApp = new Elysia()
  .get("/health", () => ({ status: "ok" }))
  .derive(({ headers, set }) => {
    const authorization = headers.authorization;

    if (!authorization) {
      set.status = 401;
      return { authorized: false, error: "Missing Authorization header" };
    }

    if (!authorization.startsWith("Bearer ")) {
      set.status = 401;
      return { authorized: false, error: "Invalid Authorization format" };
    }

    const token = authorization.slice(7);

    if (token !== config.masterToken) {
      set.status = 403;
      return { authorized: false, error: "Invalid token" };
    }

    return { authorized: true, error: null };
  })
  .onBeforeHandle(({ authorized, error, set }) => {
    if (authorized === false) {
      return { error: error || "Unauthorized" };
    }
  })
  .get("/protected", () => ({ message: "success" }))
  .get("/available-regions", () => [
    { code: "local", name: "Local", continent: "local" },
    { code: "us-east-1", name: "US East", continent: "americas" },
  ])
  .post(
    "/projects",
    ({ body }) => ({ id: "test", name: body.name }),
    {
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        region: t.Optional(t.String()),
      }),
    }
  );

const BASE = "http://localhost";

describe("Health Check", () => {
  test("GET /health should return ok", async () => {
    const res = await testApp.handle(new Request(`${BASE}/health`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

describe("Auth Middleware", () => {
  test("should return 401 without auth header", async () => {
    const res = await testApp.handle(new Request(`${BASE}/protected`));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Missing Authorization header");
  });

  test("should return 401 with Basic auth", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/protected`, { headers: BASIC_HEADER })
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid Authorization format");
  });

  test("should return 403 with invalid Bearer token", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/protected`, { headers: INVALID_TOKEN_HEADER })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Invalid token");
  });

  test("should return 200 with valid token", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/protected`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toBe("success");
  });
});

describe("Available Regions", () => {
  test("should return region list", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/available-regions`, { headers: AUTH_HEADER })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    expect(body[0]).toHaveProperty("code");
    expect(body[0]).toHaveProperty("name");
    expect(body[0]).toHaveProperty("continent");
  });
});

describe("Request Validation", () => {
  test("should reject empty name with 422", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "" }),
      })
    );
    // Elysia 返回 422 作为验证错误
    expect(res.status).toBe(422);
  });

  test("should reject missing name with 422", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(422);
  });

  test("should accept valid request", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Project" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Test Project");
  });

  test("should accept request with optional region", async () => {
    const res = await testApp.handle(
      new Request(`${BASE}/projects`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Test Project", region: "us-east-1" }),
      })
    );
    expect(res.status).toBe(200);
  });
});
