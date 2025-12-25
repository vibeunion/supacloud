
import { describe, expect, test, beforeAll, mock, spyOn, beforeEach } from "bun:test";
import jwt from "jsonwebtoken";

// Mock env vars done via process.env before import is tricky with esm, 
// but since we modify deps, we can import first.
// However, the side effect of `new SQL` happens on import.
// We must set env vars before import so that `new SQL` doesn't throw or misbehave,
// although we will replace it immediately.
process.env.JWT_SECRET = "test-secret-key-123";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.SUPABASE_DB_URL = "postgres://test:test@localhost:5432/test";
process.env.WECHAT_MINIAPP_APPID = "test-appid";
process.env.WECHAT_MINIAPP_SECRET = "test-secret";

describe("Auth Service Coverage", () => {
    let signSupabaseToken: any;
    let handler: any;
    let deps: any;

    beforeAll(async () => {
        // Import module under test
        const module = await import("../index");
        signSupabaseToken = module.signSupabaseToken;
        handler = module.handler;
        deps = module.deps;
    });

    beforeEach(() => {
        // Reset deps
        // Mock fetch
        deps.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
            openid: "test-openid",
            session_key: "test-session",
            unionid: "test-unionid"
        })))) as any;

        // Mock supabaseAdmin
        deps.supabaseAdmin = {
            auth: {
                admin: {
                    createUser: mock(() => Promise.resolve({ data: { user: { id: "new-user-id" } }, error: null }))
                }
            }
        };

        // Mock SQL
        // Tagged template mock: func(strings, ...values)
        deps.sql = mock((strings, ...values) => Promise.resolve([]));
    });

    test("signSupabaseToken creates a valid JWT", () => {
        const user = {
            id: "user-123",
            email: "test@example.com",
            app_metadata: { role: "user" },
            user_metadata: { name: "Test User" }
        };
        const token = signSupabaseToken(user);
        const decoded = jwt.verify(token, process.env.JWT_SECRET!);
        expect(decoded).toMatchObject({ sub: user.id });
    });

    test("Login Success - Create New User", async () => {
        // fetch mock is default success
        // createUser mock is default success

        const req = new Request("http://localhost:9000/auth/wechat/miniapp", {
            method: "POST",
            body: JSON.stringify({ code: "test-code", userInfo: { name: "Test" } })
        });

        const res = await handler(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.user.id).toBe("new-user-id");
    });

    test("Login Success - User Exists (Fallback to DB)", async () => {
        // CreateUser fails
        deps.supabaseAdmin.auth.admin.createUser = mock(() => Promise.resolve({
            data: null,
            error: { message: "User already registered" }
        }));

        // SQL succeeds
        deps.sql = mock(() => Promise.resolve([{ id: "existing-db-id" }]));

        const req = new Request("http://localhost:9000/auth/wechat/miniapp", {
            method: "POST",
            body: JSON.stringify({ code: "test-code2", userInfo: { name: "Test2" } })
        });

        const res = await handler(req);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.user.id).toBe("existing-db-id");
    });

    test("Login Fail - User Exists but DB lookup fails", async () => {
        deps.supabaseAdmin.auth.admin.createUser = mock(() => Promise.resolve({
            data: null,
            error: { message: "User already registered" }
        }));
        deps.sql = mock(() => Promise.resolve([])); // Empty result

        const req = new Request("http://localhost:9000/auth/wechat/miniapp", {
            method: "POST",
            body: JSON.stringify({ code: "test-code3", userInfo: {} })
        });
        const res = await handler(req);
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error).toContain("User creation failed");
    });

    test("WeChat API Error", async () => {
        deps.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
            errcode: 40029,
            errmsg: "invalid code"
        }))));

        const req = new Request("http://localhost:9000/auth/wechat/miniapp", {
            method: "POST",
            body: JSON.stringify({ code: "bad-code", userInfo: {} })
        });
        const res = await handler(req);
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error).toContain("WeChat Error");
    });

    test("404 Not Found", async () => {
        const req = new Request("http://localhost:9000/unknown-route", { method: "GET" });
        const res = await handler(req);
        expect(res.status).toBe(404);
    });
});
