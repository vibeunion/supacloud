import { expect, test } from "bun:test";
import Elysia, { t } from "elysia";
import { createApplication, createModulePlugin, type CompiledModule } from "./index";

function commandModule(write: () => unknown): CompiledModule {
  return {
    name: "receipt",
    createServices: () => ({ controller: { write } }),
    controllers: [{
      path: "/receipt", serviceKey: "controller", scope: "application",
      routes: [{
        method: "POST", path: "", handler: "write",
        response: t.Object({ id: t.String() }),
        command: "WriteCommand",
      }],
    }],
    commands: [{ className: "WriteCommand", name: "receipt.write" }],
  };
}

test("invalid output after a write is a server failure and does not execute the command again", async () => {
  let writes = 0;
  const app = createApplication({
    modules: [commandModule(() => { writes++; return { secret: "private receipt" }; })],
    commandExecutor: (_invocation, next) => next(),
  });
  const response = await app.handle(new Request("http://localhost/receipt", { method: "POST" }));
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({
    ok: false, code: "RESPONSE_VALIDATION_ERROR", message: "Response validation failed",
  });
  expect(writes).toBe(1);
});

test("custom error mapping still receives the response validation error and request context", async () => {
  let observed: unknown;
  const app = createApplication({
    modules: [commandModule(() => ({ id: 42 }))],
    commandExecutor: (_invocation, next) => next(),
    requestContext: () => ({ requestId: "request-1" }),
    errorMapper: (error, context) => {
      observed = { error, context };
      return Response.json({ code: "CUSTOM_OUTCOME_UNKNOWN" }, { status: 503 });
    },
  });
  const response = await app.handle(new Request("http://localhost/receipt", { method: "POST" }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "CUSTOM_OUTCOME_UNKNOWN" });
  expect(observed).toMatchObject({
    error: { type: "response" },
    context: { frameworkCode: "VALIDATION", requestContext: { requestId: "request-1" } },
  });
});

test("native Response passthrough is unchanged and must be validated by the handler", async () => {
  const app = createApplication({
    modules: [commandModule(() => Response.json({ id: 42 }, { headers: { "x-receipt": "native" } }))],
    commandExecutor: (_invocation, next) => next(),
  });
  const response = await app.handle(new Request("http://localhost/receipt", { method: "POST" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-receipt")).toBe("native");
  expect(await response.json()).toEqual({ id: 42 });
});

test("error mapping retains request context for every module", async () => {
  const first = commandModule(() => ({ id: 42 }));
  const second = commandModule(() => ({ id: 42 }));
  second.name = "second";
  second.controllers[0]!.path = "/second";
  const app = createApplication({
    modules: [first, second],
    commandExecutor: (_invocation, next) => next(),
    requestContext: (request) => ({ path: new URL(request.url).pathname }),
    errorMapper: (_error, context) => Response.json(context.requestContext, { status: 503 }),
  });
  for (const path of ["/receipt", "/second"]) {
    const response = await app.handle(new Request(`http://localhost${path}`, { method: "POST" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ path });
  }
});

test("standalone plugins enforce the same output error boundary without capturing host errors", async () => {
  const compiled = commandModule(() => ({ id: 42 }));
  const app = new Elysia()
    .use(createModulePlugin(compiled, compiled.createServices({}, {}), undefined, {
      commandExecutor: (_invocation, next) => next(),
    }))
    .get("/host", () => { throw new Error("host failure"); }, {
      error: () => Response.json({ code: "HOST_ERROR" }, { status: 502 }),
    });
  const response = await app.handle(new Request("http://localhost/receipt", { method: "POST" }));
  expect(response.status).toBe(500);
  expect((await response.json()).code).toBe("RESPONSE_VALIDATION_ERROR");
  const host = await app.handle(new Request("http://localhost/host"));
  expect(host.status).toBe(502);
  expect(await host.json()).toEqual({ code: "HOST_ERROR" });
});
