import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import {
  composeAspects, createCommandPipeline, ExecutionPipelineError,
  type CommandPipelineInvocation,
} from "@supacloud/app/execution";
import { createModulePlugin, defaultErrorResponse, type CommandExecutor, type CompiledModule } from "./index";

const descriptor = { className: "UpdateOrder", name: "orders.update", permission: "orders:write" };
const context = { projectRef: "project-a", requestId: "trace-a" };
function invocation(input: unknown, requestContext: unknown = context): CommandPipelineInvocation {
  return { command: descriptor, input: { body: input, params: {}, query: {} }, requestContext, services: {} };
}
function request(path: string, body: string) {
  return new Request(`http://localhost${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body,
  });
}

// This suite is explicitly part of test:conformance, exercised on beta.19.
describe("Elysia 2 native HTTP with portable application execution", () => {
  test("the same executor governs a compiled HTTP command and a request-free job call", async () => {
    const trace: string[] = [];
    const run = createCommandPipeline({
      authorize: (call) => {
        expect(call.requestContext).toEqual(context);
        trace.push("authorize");
      },
    });
    // Compile-time compatibility with the existing Elysia adapter extension point.
    const commandExecutor: CommandExecutor = run;
    const module: CompiledModule = {
      name: "orders",
      createServices: () => ({ controller: { update: () => { trace.push("handler"); return { ok: true }; } } }),
      controllers: [{ path: "", serviceKey: "controller", scope: "application", routes: [{
        method: "POST", path: "/orders", handler: "update", command: descriptor.className,
        body: t.Object({ value: t.Number() }),
      }] }],
      commands: [descriptor],
      // Existing compiler-emitted pipelines remain supported. Hand-authored
      // descriptors can also use the portable composition implementation.
      aspectPipeline: composeAspects(async (call, next) => {
        expect(call.kind).toBe("command");
        trace.push("aspect:before");
        const result = await next();
        trace.push("aspect:after");
        return result;
      }),
    };
    const app = new Elysia().use(createModulePlugin(module, module.createServices({}, {}), () => context, { commandExecutor }));
    const response = await app.handle(request("/orders", '{"value":1}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(trace).toEqual(["authorize", "aspect:before", "handler", "aspect:after"]);

    trace.length = 0;
    const call = invocation({ value: 2 });
    expect(call.request).toBeUndefined();
    const result = await run(call, () => { trace.push("handler"); return { ok: true }; });
    expect(result).toEqual({ ok: true });
    expect(trace).toEqual(["authorize", "handler"]);
  });

  test("native macro derive supplies HTTP context without becoming business authorization", async () => {
    let checks = 0;
    let writes = 0;
    let derives = 0;
    const run = createCommandPipeline({
      authorize: call => {
        checks++;
        if (call.requestContext !== context) throw new ExecutionPipelineError("Project access denied", "PROJECT_ACCESS_DENIED", 403);
      },
    });
    // Elysia 2 object macro, derive (not resolve), and schema-before-handler.
    const http = new Elysia({ name: "application-execution-http" })
      .macro({
        applicationContext: {
          derive: () => { derives++; return { executionContext: context }; },
        },
      });
    const app = new Elysia()
      .use(http)
      .error(({ error }) => defaultErrorResponse(error))
      .post("/native", {
        applicationContext: true,
        body: t.Object({ value: t.Number() }),
      }, ({ body, executionContext }) => run(invocation(body, executionContext), () => { writes++; return { ok: true }; }));
    const response = await app.handle(request("/native", '{"value":1}'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(derives).toBe(1);
    expect(checks).toBe(1);
    expect(writes).toBe(1);
    // No HTTP macro runs here; the business boundary must still reject access.
    await expect(Promise.resolve(run(invocation({}, { projectRef: "project-b" }), () => { writes++; })))
      .rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(checks).toBe(2);
    expect(writes).toBe(1);
  });

  test("portable configuration errors retain the adapter's public error contract", async () => {
    let writes = 0;
    const run = createCommandPipeline({ authorize: () => {} });
    const app = new Elysia()
      .error(({ error }) => defaultErrorResponse(error))
      .post("/missing-transaction", {}, () => run({
        ...invocation({}), command: { ...descriptor, transaction: "required" },
      }, () => { writes++; }));
    const response = await app.handle(request("/missing-transaction", "{}"));
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: "COMMAND_TRANSACTION_UNAVAILABLE" });
    expect(writes).toBe(0);
  });

  test("denied compiled commands never enter module aspects", async () => {
    let entered = 0;
    const module: CompiledModule = {
      name: "denied",
      createServices: () => ({ controller: { run: () => { entered++; return "no"; } } }),
      controllers: [{ path: "", serviceKey: "controller", scope: "application", routes: [{
        method: "POST", path: "/denied", handler: "run", command: descriptor.className,
      }] }],
      commands: [descriptor],
      aspectPipeline: composeAspects((_call, next) => { entered++; return next(); }),
    };
    const app = new Elysia().use(createModulePlugin(module, module.createServices({}, {}), () => context, {
      commandExecutor: createCommandPipeline({ authorize: () => {
        throw new ExecutionPipelineError("Project access denied", "PROJECT_ACCESS_DENIED", 403);
      } }),
    }));
    const response = await app.handle(request("/denied", "{}"));
    expect(response.status).toBe(403);
    expect(entered).toBe(0);
  });
});
