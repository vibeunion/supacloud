import { expect, test } from "bun:test";
import { createAppMcpHandler, createAppMcpRoutes, isAppMcpRequest } from "./app-server";
import type { ProjectJwtContext } from "../middleware/auth";

const makeRequest = (body: unknown, headers: Record<string, string> = {}) => new Request(
  "http://localhost/mcp/app/projects/alpha",
  {
    method: "POST",
    headers: {
      authorization: "Bearer user.jwt.token",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  },
);

const readRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "app.read_table",
    arguments: { table: "items", select: "id,name" },
  },
};

test("app MCP preserves the authenticated user JWT on the project Data API request", async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const handler = createAppMcpHandler({
    verify: async () => ({ ref: "alpha", role: "authenticated", sub: "user-a" }),
    port: async () => 3001,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
      expect(init?.redirect).toBe("error");
      return Response.json([{ id: 1 }]);
    },
  });

  const response = await handler(makeRequest(readRequest), "alpha");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).result.content[0].text).toContain("user-a");
  expect(calls).toEqual([{
    url: "http://127.0.0.1:3001/items?select=id%2Cname&limit=100&offset=0",
    authorization: "Bearer user.jwt.token",
  }]);
});

test("app MCP rejects privileged, anonymous, missing-user and cross-project tokens before IO", async () => {
  const principals: (ProjectJwtContext | null)[] = [
    null,
    { ref: "alpha", role: "service_role", sub: "root" },
    { ref: "alpha", role: "anon" },
    { ref: "alpha", role: "authenticated" },
    { ref: "beta", role: "authenticated", sub: "user" },
  ];

  for (const principal of principals) {
    const handler = createAppMcpHandler({
      verify: async () => principal,
      port: async () => { throw new Error("must not resolve project ports"); },
      fetcher: fetch,
    });
    expect((await handler(makeRequest(readRequest), "alpha")).status).toBe(401);
  }
});

test("app MCP fails closed for invalid protocol, origin, input and response size", async () => {
  const handler = createAppMcpHandler({
    verify: async () => ({ ref: "alpha", role: "authenticated", sub: "user" }),
    port: async () => 3001,
    fetcher: async () => Response.json("x".repeat(1_048_577)),
  });
  expect((await handler(makeRequest(readRequest, { origin: "https://attacker.test" }), "alpha")).status).toBe(403);
  expect((await handler(makeRequest(readRequest, { "mcp-protocol-version": "invalid" }), "alpha")).status).toBe(400);
  expect((await handler(makeRequest({ ...readRequest, params: [] }), "alpha")).status).toBe(400);

  const invalidSelect = structuredClone(readRequest);
  (invalidSelect.params.arguments as Record<string, unknown>).select = "*bad";
  expect((await (await handler(makeRequest(invalidSelect), "alpha")).json()).error.code).toBe(-32602);
  expect((await (await handler(makeRequest(readRequest), "alpha")).json()).error.code).toBe(-32602);
  expect(isAppMcpRequest(makeRequest(readRequest))).toBe(true);
  expect(isAppMcpRequest(new Request("http://localhost/v1/projects/alpha"))).toBe(false);
});

test("mounted app MCP retains the request stream and does not disclose verification failures", async () => {
  const app = createAppMcpRoutes(createAppMcpHandler({
    verify: async () => ({ ref: "alpha", role: "authenticated", sub: "user" }),
    port: async () => 3001,
    fetcher: async () => Response.json([{ owner: "user" }]),
    authorizationServer: async () => "https://auth.example.com/auth/v1",
  }));
  const response = await app.handle(makeRequest(readRequest));
  expect(response.status).toBe(200);
  expect((await response.json()).result.content[0].text).toContain('"owner":"user"');
  expect((await app.handle(makeRequest({ ...readRequest, oversized: "x".repeat(65536) }))).status).toBe(400);
  const unavailable = createAppMcpHandler({
    verify: async () => { throw new Error("sensitive DSN"); }, port: async () => 3001, fetcher: fetch,
  });
  const rejected = await unavailable(makeRequest(readRequest), "alpha");
  expect(rejected.status).toBe(503);
  expect(await rejected.text()).not.toContain("sensitive");
  const metadata = await app.handle(new Request("http://localhost/.well-known/oauth-protected-resource/mcp/app/projects/alpha"));
  expect(metadata.status).toBe(200);
  expect((await metadata.json()).authorization_servers).toEqual(["https://auth.example.com/auth/v1"]);
  const unauthorized = await app.handle(new Request("http://localhost/mcp/app/projects/alpha", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }));
  expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");
});

test("OAuth discovery uses the configured public origin and fails closed when unavailable", async () => {
  const dependencies = {
    verify: async () => null, port: async () => 3001, fetcher: fetch,
    publicOrigin: "https://project.example",
  };
  const app = createAppMcpRoutes(createAppMcpHandler(dependencies));
  const challenge = await app.handle(makeRequest(readRequest, { authorization: "" }));
  expect(challenge.headers.get("www-authenticate")).toContain("https://project.example/.well-known/");
  const path = "http://localhost/.well-known/oauth-protected-resource/mcp/app/projects/alpha";
  expect((await app.handle(new Request(path))).status).toBe(503);
  expect(isAppMcpRequest(new Request(path))).toBe(true);
  expect(isAppMcpRequest(new Request(`${path}/other`))).toBe(false);
  expect(() => createAppMcpHandler({ ...dependencies, publicOrigin: "http://public.example" })).toThrow();
});
