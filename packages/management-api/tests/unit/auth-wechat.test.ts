import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { wechatAuthInternals } from "../../src/routes/auth-wechat";

function expectWechatLoginResponseContract(functionCode: string) {
  expect(functionCode).toContain("export default async function handler(req: Request)");
  expect(functionCode).not.toContain("Deno.serve");
  expect(functionCode).toContain("const responseUser = finalSession.user ?? null");
  expect(functionCode).toContain("JSON.stringify({ data: { session: finalSession, user: responseUser } })");
  expect(functionCode).toContain("JSON.stringify({ data: { session: null, user: null }, error:");
  expect(functionCode).not.toContain("(finalSession as any).user");
}

async function expectSelfContainedBundle(functionCode: string) {
  const directory = await mkdtemp(join(tmpdir(), "supacloud-wechat-function-"));
  try {
    const entrypoint = join(directory, "index.ts");
    await Bun.write(entrypoint, functionCode);
    const result = await Bun.build({ entrypoints: [entrypoint], target: "bun" });
    expect(result.success).toBe(true);
    expect(result.logs).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("wechat auth edge function generators", () => {
  test("mini program login success response matches supabase-mp-js contract", () => {
    const functionCode = wechatAuthInternals.generateWeChatMiniProgramLoginFunction();

    expectWechatLoginResponseContract(functionCode);
    expect(functionCode).not.toContain("@supabase/supabase-js");
    expect(functionCode).toContain("SUPACLOUD_INTERNAL_AUTH_URL");
    expect(functionCode).toContain("WECHAT_MINIPROGRAM_APP_SECRET");
  });

  test("official account login success response matches supabase-mp-js contract", () => {
    const functionCode = wechatAuthInternals.generateWeChatMPLoginFunction();

    expectWechatLoginResponseContract(functionCode);
    expect(functionCode).not.toContain("@supabase/supabase-js");
    expect(functionCode).toContain("WECHAT_MP_APP_SECRET");
  });

  test("generated login functions bundle without npm dependencies", async () => {
    await expectSelfContainedBundle(wechatAuthInternals.generateWeChatMiniProgramLoginFunction());
    await expectSelfContainedBundle(wechatAuthInternals.generateWeChatMPLoginFunction());
  });

  test("mini program function exchanges a code for a refreshable session through GoTrue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supacloud-wechat-function-run-"));
    const originalFetch = globalThis.fetch;
    const envNames = [
      "WECHAT_MINIPROGRAM_APP_ID",
      "WECHAT_MINIPROGRAM_APP_SECRET",
      "SUPACLOUD_INTERNAL_AUTH_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "X_PROJECT_REF",
      "SUPABASE_DB_URL",
    ] as const;
    const originalEnv = Object.fromEntries(envNames.map((name) => [name, Bun.env[name]]));
    const authRequests: Array<{ url: string; method: string; headers: Headers }> = [];
    const user = {
      id: "11111111-1111-1111-1111-111111111111",
      user_metadata: {},
      app_metadata: {},
    };

    try {
      Bun.env.WECHAT_MINIPROGRAM_APP_ID = "test-app-id";
      Bun.env.WECHAT_MINIPROGRAM_APP_SECRET = "test-app-secret";
      Bun.env.SUPACLOUD_INTERNAL_AUTH_URL = "http://auth.internal/auth/v1";
      Bun.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role";
      Bun.env.X_PROJECT_REF = "test-project";
      delete Bun.env.SUPABASE_DB_URL;

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.weixin.qq.com/sns/jscode2session")) {
          return Response.json({ openid: "openid", unionid: "unionid", session_key: "provider-token" });
        }

        const method = init?.method || "GET";
        const headers = new Headers(init?.headers);
        authRequests.push({ url, method, headers });
        if (url.endsWith("/admin/users") && method === "POST") return Response.json(user, { status: 201 });
        if (url.endsWith("/admin/generate_link")) return Response.json({ ...user, hashed_token: "hashed-token" });
        if (url.endsWith("/verify")) {
          return Response.json({ access_token: "access-token", refresh_token: "refresh-token", expires_in: 3600, user });
        }
        if (url.endsWith(`/admin/users/${user.id}`) && method === "PUT") {
          return Response.json({ ...user, user_metadata: { openid: "openid" } });
        }
        if (url.endsWith(`/admin/users/${user.id}`) && method === "GET") {
          return Response.json({ ...user, user_metadata: { openid: "openid" } });
        }
        return Response.json({ message: "unexpected request" }, { status: 500 });
      }) as typeof fetch;

      const entrypoint = join(directory, "index.ts");
      await Bun.write(entrypoint, wechatAuthInternals.generateWeChatMiniProgramLoginFunction());
      const moduleUrl = `${pathToFileURL(entrypoint).href}?test=${Date.now()}`;
      const loginFunction = (await import(moduleUrl)).default as (request: Request) => Promise<Response>;
      const response = await loginFunction(new Request("http://localhost/functions/v1/wechat-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "wx-code" }),
      }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.data.session).toMatchObject({
        access_token: "access-token",
        refresh_token: "refresh-token",
        provider_token: "provider-token",
      });
      expect(payload.data.user.user_metadata.openid).toBe("openid");
      expect(authRequests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST http://auth.internal/auth/v1/admin/users",
        "POST http://auth.internal/auth/v1/admin/generate_link",
        "POST http://auth.internal/auth/v1/verify",
        `PUT http://auth.internal/auth/v1/admin/users/${user.id}`,
        `GET http://auth.internal/auth/v1/admin/users/${user.id}`,
      ]);
      for (const request of authRequests) {
        expect(request.headers.get("authorization")).toBe("Bearer test-service-role");
        expect(request.headers.get("x-project-ref")).toBe("test-project");
      }
    } finally {
      globalThis.fetch = originalFetch;
      for (const name of envNames) {
        const value = originalEnv[name];
        if (value === undefined) delete Bun.env[name];
        else Bun.env[name] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
