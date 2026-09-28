import { describe, expect, test } from "bun:test";
import { Elysia, status, t } from "elysia";
import { readFile } from "node:fs/promises";
import {
  createModulePlugin,
  type CompiledModule,
  type CompiledRoute,
} from "./index";

interface Input {
  body?: unknown;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  cookie?: Record<string, unknown>;
}

function moduleFor(
  handler: (input: Input) => unknown,
  route: Partial<CompiledRoute> = {},
): CompiledModule {
  return {
    name: "conformance",
    createServices: () => ({ controller: { run: handler } }),
    controllers: [{
      path: "",
      serviceKey: "controller",
      scope: "application",
      routes: [{ method: "POST", path: "/probe", handler: "run", ...route }],
    }],
  };
}

function pluginFor(handler: (input: Input) => unknown, route: Partial<CompiledRoute> = {}) {
  const compiled = moduleFor(handler, route);
  return createModulePlugin(compiled, compiled.createServices({}, {}));
}

function jsonRequest(body: string) {
  return new Request("http://localhost/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function snapshot(response: Response) {
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    trace: response.headers.get("x-trace"),
    cookie: response.headers.get("set-cookie"),
    body: await response.text(),
  };
}

describe("native Elysia and compiled adapter conformance", () => {
  test("records the exact exercised runtime and schema versions", async () => {
    const matrix: unknown = await Bun.file(new URL("../compatibility.json", import.meta.url)).json();
    const packages: Record<string, string> = {};
    for (const name of ["elysia", "typescript", "typebox", "exact-mirror", "@typescript/typescript6"] as const) {
      const manifest: unknown = JSON.parse(await readFile(
        new URL(`../node_modules/${name}/package.json`, import.meta.url), "utf8",
      ));
      if (!manifest || typeof manifest !== "object"
        || !("version" in manifest) || typeof manifest.version !== "string") {
        throw new Error(`Invalid manifest for ${name}`);
      }
      packages[name] = manifest.version;
    }
    expect(matrix).toEqual({ bun: Bun.version, packages });
  });

  test("rejects unsupported methods and native route options at registration", () => {
    for (const invalid of [{ method: "TRACE" }, { beforeHandle: () => "ignored" }]) {
      const compiled = moduleFor(() => "unreachable");
      const route = compiled.controllers[0]?.routes[0];
      if (!route) throw new Error("Missing fixture route");
      Object.assign(route, invalid);
      expect(() => createModulePlugin(compiled, compiled.createServices({}, {})))
        .toThrow("Unsupported compiled route");
    }
  });

  test("protocol errors from another package copy remain redacted and unknown codes stay internal", async () => {
    for (const [code, expectedStatus, expectedCode] of [
      ["COMMAND_REJECTED", 403, "COMMAND_REJECTED"],
      ["COMMAND_OUTCOME_UNKNOWN", 503, "COMMAND_OUTCOME_UNKNOWN"],
      ["PRIVATE_ERROR", 500, "INTERNAL_ERROR"],
    ] as const) {
      const error = Object.assign(new Error("secret-detail"), { name: "CommandError", code });
      const app = new Elysia().use(pluginFor(() => { throw error; }));
      const response = await app.handle(jsonRequest("{}"));
      expect(response.status).toBe(expectedStatus);
      const text = await response.text();
      expect(text).toContain(expectedCode);
      expect(text).not.toContain("secret-detail");
    }
    const app = new Elysia().use(pluginFor(() => {
      throw { name: "CommandError", code: "COMMAND_REJECTED", message: "secret-detail" };
    }));
    const response = await app.handle(jsonRequest("{}"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "INTERNAL_ERROR" });
  });

  test("decodes request fields and normalizes response objects identically", async () => {
    const schemas = {
      body: t.Object({ name: t.String() }),
      params: t.Object({ id: t.Numeric() }),
      query: t.Object({ count: t.Numeric() }),
      headers: t.Object({ "x-label": t.String() }),
      cookie: t.Object({ session: t.String() }),
      response: t.Object({
        name: t.String(), id: t.Number(), count: t.Number(),
        label: t.String(), session: t.String(),
      }),
    };
    const native = new Elysia({ normalize: true }).post("/probe/:id", schemas, (ctx) => ({
      name: ctx.body.name,
      id: ctx.params.id,
      count: ctx.query.count,
      label: ctx.headers["x-label"],
      session: ctx.cookie.session.value,
      extra: "removed",
    }));
    const adapted = new Elysia({ normalize: true }).use(pluginFor((input) => ({
      name: (input.body as { name: string }).name,
      id: input.params?.id,
      count: input.query?.count,
      label: input.headers?.["x-label"],
      session: input.cookie?.session,
      extra: "removed",
    }), { ...schemas, path: "/probe/:id" }));
    const request = new Request("http://localhost/probe/7?count=3", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-label": "test",
        cookie: "session=s1",
      },
      body: JSON.stringify({ name: "sample", extra: "removed" }),
    });
    const result = await adapted.handle(request.clone());
    expect(result.status).toBe(200);
    expect(await result.clone().json()).toEqual({
      name: "sample", id: 7, count: 3, label: "test", session: "s1",
    });
    expect(await snapshot(result)).toEqual(await snapshot(await native.handle(request)));
  });

  test("keeps declared status-code responses", async () => {
    const responses = { 409: t.Object({ conflict: t.Boolean() }) };
    const handler = () => status(409, { conflict: true });
    const native = new Elysia().post("/probe", { response: responses }, handler);
    const adapted = new Elysia().use(pluginFor(handler, { responses }));
    const request = jsonRequest("{}");
    const result = await adapted.handle(request.clone());
    expect(result.status).toBe(409);
    expect(await snapshot(result)).toEqual(await snapshot(await native.handle(request)));
  });

  test("preserves native Response headers, cookies and body", async () => {
    const handler = () => new Response("accepted", {
      status: 202,
      headers: { "x-trace": "trace-1", "set-cookie": "session=s1; HttpOnly" },
    });
    const native = new Elysia().post("/probe", handler);
    const adapted = new Elysia().use(pluginFor(handler, { nativeResponse: true }));
    const request = jsonRequest("{}");
    const result = await adapted.handle(request.clone());
    expect(result.status).toBe(202);
    expect(await snapshot(result)).toEqual(await snapshot(await native.handle(request)));
  });

  test("runs parent lifecycle hooks in native order", async () => {
    const nativeEvents: string[] = [];
    const adapterEvents: string[] = [];
    const root = (events: string[]) => new Elysia()
      .request(() => { events.push("request"); })
      .beforeHandle(() => { events.push("before"); })
      .afterHandle(() => { events.push("after"); });
    const native = root(nativeEvents).use(new Elysia().post("/probe", () => {
      nativeEvents.push("handler");
      return { ok: true };
    }));
    const adapted = root(adapterEvents).use(pluginFor(() => {
      adapterEvents.push("handler");
      return { ok: true };
    }));
    const request = jsonRequest("{}");
    expect(await snapshot(await adapted.handle(request.clone())))
      .toEqual(await snapshot(await native.handle(request)));
    expect(adapterEvents).toEqual(["request", "before", "handler", "after"]);
    expect(adapterEvents).toEqual(nativeEvents);
  });

  test("parent early return prevents controller execution", async () => {
    let calls = 0;
    const handler = () => { calls++; return { ok: true }; };
    const root = () => new Elysia().beforeHandle(() => status(403, "denied"));
    const native = root().use(new Elysia().post("/probe", handler));
    const adapted = root().use(pluginFor(handler));
    const request = jsonRequest("{}");
    const result = await adapted.handle(request.clone());
    expect(result.status).toBe(403);
    expect(await snapshot(result)).toEqual(await snapshot(await native.handle(request)));
    expect(calls).toBe(0);
  });

  test.each([
    { name: "missing auth", token: undefined, failure: undefined, status: 401, code: "unauthenticated", writes: 0, audits: 0, mappings: 0 },
    { name: "denied permission", token: "reader", failure: undefined, status: 403, code: "permission_denied", writes: 0, audits: 0, mappings: 0 },
    { name: "successful write", token: "writer", failure: undefined, status: 200, code: "written", writes: 1, audits: 1, mappings: 0 },
    { name: "trusted upstream failure", token: "writer", failure: "upstream", status: 502, code: "invalid_upstream_response", writes: 0, audits: 0, mappings: 1 },
    { name: "audit failure after write", token: "writer", failure: "audit", status: 500, code: "audit_failed", writes: 1, audits: 1, mappings: 1 },
  ] as const)("incremental sibling routes preserve $name without replay", async (scenario) => {
    class InvalidUpstreamResponse extends Error {}
    class AuditFailure extends Error {}
    const counts = {
      native: { calls: 0, writes: 0, audits: 0, mappings: 0 },
      compiled: { calls: 0, writes: 0, audits: 0, mappings: 0 },
    };
    const events = { native: [] as string[], compiled: [] as string[] };
    type RouteKind = keyof typeof counts;
    const routeKind = (request: Request): RouteKind =>
      new URL(request.url).pathname === "/native" ? "native" : "compiled";
    const mapError = (kind: RouteKind, error: unknown) => {
      counts[kind].mappings++;
      events[kind].push("error");
      if (error instanceof InvalidUpstreamResponse) {
        return Response.json({ code: "invalid_upstream_response" }, { status: 502 });
      }
      if (error instanceof AuditFailure) {
        return Response.json({ code: "audit_failed" }, { status: 500 });
      }
      return Response.json({ code: "unexpected_error" }, { status: 500 });
    };
    const write = (kind: RouteKind) => {
      counts[kind].calls++;
      events[kind].push("handler");
      if (scenario.failure === "upstream") {
        throw new InvalidUpstreamResponse("private upstream payload");
      }
      counts[kind].writes++;
      events[kind].push("write");
      return { code: "written" };
    };
    const compiled = moduleFor(() => write("compiled"), { path: "/compiled" });
    const app = new Elysia()
      .beforeHandle(({ request }) => {
        const kind = routeKind(request);
        events[kind].push("authenticate");
        const token = request.headers.get("authorization");
        if (!token) return status(401, { code: "unauthenticated" });
        events[kind].push("authorize");
        if (token !== "Bearer writer") return status(403, { code: "permission_denied" });
      })
      .afterHandle(({ request, responseValue }) => {
        if (!responseValue || typeof responseValue !== "object"
          || !("code" in responseValue) || responseValue.code !== "written") return;
        const kind = routeKind(request);
        counts[kind].audits++;
        events[kind].push("audit");
        if (scenario.failure === "audit") throw new AuditFailure("private audit detail");
      })
      .use(new Elysia().post("/native", {
        error: ({ error }) => mapError("native", error),
      }, () => write("native")))
      .use(createModulePlugin(compiled, compiled.createServices({}, {}), undefined, {
        errorMapper: (error) => mapError("compiled", error),
      }));
    const results = [];
    for (const kind of ["native", "compiled"] as const) {
      const response = await app.handle(new Request(`http://localhost/${kind}`, {
        method: "POST",
        headers: scenario.token ? { authorization: `Bearer ${scenario.token}` } : {},
      }));
      expect(response.status).toBe(scenario.status);
      expect(await response.clone().json()).toEqual({ code: scenario.code });
      results.push(await snapshot(response));
      expect(counts[kind]).toEqual({
        calls: scenario.token === "writer" ? 1 : 0,
        writes: scenario.writes,
        audits: scenario.audits,
        mappings: scenario.mappings,
      });
    }
    expect(results[1]).toEqual(results[0]);
    const expectedEvents = ["authenticate"];
    if (scenario.token) expectedEvents.push("authorize");
    if (scenario.token === "writer") expectedEvents.push("handler");
    if (scenario.writes) expectedEvents.push("write");
    if (scenario.audits) expectedEvents.push("audit");
    if (scenario.mappings) expectedEvents.push("error");
    expect(events.native).toEqual(expectedEvents);
    expect(events.compiled).toEqual(expectedEvents);
  });

  test("keeps local sibling hooks encapsulated", async () => {
    const root = () => new Elysia().use(
      new Elysia().beforeHandle(() => status(418, "local")).get("/local", () => "unused"),
    );
    const native = root().use(new Elysia().post("/probe", () => "ok"));
    const adapted = root().use(pluginFor(() => "ok"));
    const request = jsonRequest("{}");
    const result = await adapted.handle(request.clone());
    expect(result.status).toBe(200);
    expect(await snapshot(result)).toEqual(await snapshot(await native.handle(request)));
    expect((await adapted.handle(new Request("http://localhost/local"))).status).toBe(418);
  });

  test("rejects invalid input before executing the controller", async () => {
    let calls = 0;
    const handler = () => { calls++; return "unreachable"; };
    const body = t.Object({ name: t.String() });
    const native = new Elysia().post("/probe", { body }, handler);
    const adapted = new Elysia().use(pluginFor(handler, { body }));
    const request = jsonRequest('{"name":123}');
    const result = await adapted.handle(request.clone());
    expect(result.status).toBe(422);
    expect(result.status).toBe((await native.handle(request)).status);
    expect(await result.json()).toEqual({
      ok: false, code: "VALIDATION_ERROR", message: "Request validation failed",
    });
    expect(calls).toBe(0);
  });

  test.each(['{"name":', '{"name":"secret",}', "{", "not-json"])(
    "malformed JSON %s is a client error, not a server failure", async (payload) => {
      let calls = 0;
      const handler = () => { calls++; return "unreachable"; };
      const body = t.Object({ name: t.String() });
      const native = new Elysia().post("/probe", { body }, handler);
      const adapted = new Elysia().use(pluginFor(handler, { body }));
      const request = jsonRequest(payload);
      const result = await adapted.handle(request.clone());
      expect(result.status).toBe(400);
      expect(result.status).toBe((await native.handle(request)).status);
      expect(await result.json()).toEqual({
        ok: false, code: "PARSE_ERROR", message: "Request body could not be parsed",
      });
      expect(calls).toBe(0);
    },
  );

  test("keeps the custom mapper authoritative for parse failures", async () => {
    let frameworkCode: string | number | undefined;
    let contextCalls = 0;
    const compiled = moduleFor(() => "unreachable", {
      body: t.Object({ name: t.String() }),
    });
    const adapted = new Elysia().use(createModulePlugin(
      compiled,
      compiled.createServices({}, {}),
      () => { contextCalls++; return {}; },
      {
        errorMapper: (_error, context) => {
          frameworkCode = context.frameworkCode;
          return Response.json({ code: "CUSTOM_PARSE" }, { status: 400 });
        },
      },
    ));
    const response = await adapted.handle(jsonRequest("{"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "CUSTOM_PARSE" });
    expect(frameworkCode).toBe("PARSE");
    expect(contextCalls).toBe(0);
  });

  test("redacts handler exceptions without leaking error mapping to siblings", async () => {
    const adapted = new Elysia()
      .use(pluginFor(() => { throw new Error("private-password"); }))
      .get("/sibling", () => { throw new Error("native-error"); });
    const result = await adapted.handle(jsonRequest("{}"));
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({
      ok: false, code: "INTERNAL_ERROR", message: "Internal Server Error",
    });
    const native = new Elysia().get("/sibling", () => { throw new Error("native-error"); });
    const request = new Request("http://localhost/sibling");
    expect(await snapshot(await adapted.handle(request.clone())))
      .toEqual(await snapshot(await native.handle(request)));
  });

  test("response schema failures are server errors by design", async () => {
    const adapted = new Elysia().use(pluginFor(() => ({ ok: "invalid" }), {
      responses: { 200: t.Object({ ok: t.Boolean() }) },
    }));
    const result = await adapted.handle(jsonRequest("{}"));
    expect(result.status).toBe(500);
    expect(await result.json()).toEqual({
      ok: false, code: "RESPONSE_VALIDATION_ERROR", message: "Response validation failed",
    });
  });
});
