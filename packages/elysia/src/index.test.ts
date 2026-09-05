import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import {
  ApplicationError,
  composeAspects,
  composeCommandExecutors,
  createApplication,
  createModulePlugin,
  createSupaCloudRequestContext,
  createTestApp,
  defaultErrorResponse,
  executeJob,
  requireIdempotencyKey,
  requireTrustedIdentity,
  type ApplicationOptions,
  type CommandGovernance,
  type CompiledModule,
} from "./index";
import { testRequest } from "./testing";

// ---------------------------------------------------------------------------
// Hand-written compiled module fixtures (mirrors @supacloud/compiler output)
// ---------------------------------------------------------------------------

class AuditService {
  readonly entries: string[] = [];

  record(entry: string): void {
    this.entries.push(entry);
  }
}

interface Captured {
  auditService?: AuditService;
  caseImported?: Record<string, Record<string, unknown>>;
  caseDeps?: Record<string, unknown>;
  requestScopeDestroyed?: number;
}

function createAuditModule(captured: Captured): CompiledModule {
  return {
    name: "audit",
    createServices: () => {
      captured.auditService = new AuditService();
      return { auditService: captured.auditService };
    },
    controllers: [],
    commands: [],
  };
}

class CaseService {
  constructor(private readonly audit: AuditService) {}

  findById(id: string): { id: string; title: string } {
    this.audit.record(`case.get:${id}`);
    return { id, title: `Case ${id}` };
  }

  create(input: { title: string }): { id: string; title: string } {
    if (input.title === "fail") throw new Error("create failed");
    this.audit.record(`case.create:${input.title}`);
    return { id: "case-1", title: input.title };
  }
}

class CaseController {
  constructor(
    private readonly cases: CaseService,
    private readonly requestId: string,
  ) {}

  get(input: { params: { id: string } }) {
    return { ...this.cases.findById(input.params.id), requestId: this.requestId };
  }

  create(input: { body: { title: string } }) {
    return this.cases.create(input.body);
  }
}

function createCaseModule(captured: Captured): CompiledModule {
  return {
    name: "case",
    createServices: (deps, imported) => {
      captured.caseDeps = deps;
      captured.caseImported = imported;
      const audit = imported.audit?.auditService as AuditService | undefined;
      if (!audit) {
        throw new Error("case module requires the audit module");
      }
      return { caseService: new CaseService(audit) };
    },
    createRequestScope: (services, ctx) => {
      const { requestId } = ctx as { requestId: string };
      return {
        caseController: new CaseController(
          services.caseService as CaseService,
          requestId,
        ),
      };
    },
    destroyRequestScope: async () => {
      captured.requestScopeDestroyed = (captured.requestScopeDestroyed ?? 0) + 1;
    },
    controllers: [
      {
        path: "/cases",
        serviceKey: "caseController",
        scope: "request",
        routes: [
          {
            method: "GET",
            path: "/:id",
            handler: "get",
            params: t.Object({ id: t.String() }),
          },
          {
            method: "POST",
            path: "/",
            handler: "create",
            body: t.Object({ title: t.String() }),
            response: t.Object({ id: t.String(), title: t.String() }),
            command: "CreateCaseCommand",
          },
        ],
      },
    ],
    commands: [
      {
        className: "CreateCaseCommand",
        name: "case.create",
        permission: "case.create",
        transaction: "required",
        audit: "case.created",
        idempotency: "required",
      },
    ],
  };
}

const requestIdFromHeader: ApplicationOptions["requestContext"] = (request) => ({
  requestId: request.headers.get("x-request-id") ?? "anonymous",
  request,
});

const passthroughGovernance: CommandGovernance = {
  authorize: () => {},
  idempotency: (_invocation, next) => next(),
  transaction: (_invocation, next) => next(),
  audit: {
    succeeded: () => {},
    failed: () => {},
  },
};

function createApp(captured: Captured, options?: Partial<ApplicationOptions>) {
  return createTestApp({
    modules: [createAuditModule(captured), createCaseModule(captured)],
    requestContext: requestIdFromHeader,
    commandGovernance: passthroughGovernance,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createApplication", () => {
  test("serves GET and POST routes with JSON responses", async () => {
    const app = createApp({});

    const getRes = await testRequest(app, "/cases/42", {
      headers: { "x-request-id": "req-get" },
    });
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual({
      id: "42",
      title: "Case 42",
      requestId: "req-get",
    });

    const postRes = await testRequest(app, "/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "hello" }),
    });
    expect(postRes.status).toBe(200);
    expect(await postRes.json()).toEqual({ id: "case-1", title: "hello" });
  });

  test("rejects invalid bodies with 422 via Elysia validation", async () => {
    const app = createApp({});

    const res = await testRequest(app, "/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  test("builds an isolated request scope per request", async () => {
    const app = createApp({});

    const [resA, resB] = await Promise.all([
      testRequest(app, "/cases/a", { headers: { "x-request-id": "req-a" } }),
      testRequest(app, "/cases/b", { headers: { "x-request-id": "req-b" } }),
    ]);
    const bodyA = (await resA.json()) as { requestId: string };
    const bodyB = (await resB.json()) as { requestId: string };
    expect(bodyA.requestId).toBe("req-a");
    expect(bodyB.requestId).toBe("req-b");

    // Default context factory assigns a fresh requestId per request.
    const defaultApp = createApplication({
      modules: [createAuditModule({}), createCaseModule({})],
      commandGovernance: passthroughGovernance,
    });
    const [first, second] = await Promise.all([
      testRequest(defaultApp, "/cases/1"),
      testRequest(defaultApp, "/cases/2"),
    ]);
    const firstId = ((await first.json()) as { requestId: string }).requestId;
    const secondId = ((await second.json()) as { requestId: string }).requestId;
    expect(firstId).not.toBe(secondId);
  });

  test("resolves module imports and platform deps", async () => {
    const captured: Captured = {};
    const deps = { db: { kind: "pg" } };
    const app = createApp(captured, { deps });

    // The case module saw the audit module's exported services and deps.
    expect(captured.caseDeps).toBe(deps);
    expect(captured.caseImported?.audit?.auditService).toBe(captured.auditService);

    // CaseService actually uses the audit module's service.
    const res = await testRequest(app, "/cases/7");
    expect(res.status).toBe(200);
    expect(captured.auditService?.entries).toEqual(["case.get:7"]);
  });

  test("executes command governance in authorization, idempotency, transaction and audit order", async () => {
    const events: string[] = [];
    const app = createApp({}, {
      commandGovernance: {
        authorize: (invocation) => {
          events.push(`authorize:${invocation.command.permission}`);
        },
        idempotency: async (_invocation, next) => {
          events.push("idempotency:before");
          const result = await next();
          events.push("idempotency:after");
          return result;
        },
        transaction: async (_invocation, next) => {
          events.push("transaction:before");
          const result = await next();
          events.push("transaction:after");
          return result;
        },
        audit: {
          succeeded: (invocation) => {
            events.push(`audit:success:${invocation.command.audit}`);
          },
          failed: () => {
            events.push("audit:failure");
          },
        },
      },
    });

    const res = await testRequest(app, "/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "governed" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "case-1", title: "governed" });
    expect(events).toEqual([
      "authorize:case.create",
      "idempotency:before",
      "transaction:before",
      "audit:success:case.created",
      "transaction:after",
      "idempotency:after",
    ]);
  });

  test("records command failure only after the transaction has rolled back", async () => {
    const events: string[] = [];
    const app = createApp({}, {
      commandGovernance: {
        authorize: () => {
          events.push("authorize");
        },
        idempotency: async (_invocation, next) => {
          events.push("idempotency:before");
          return next();
        },
        transaction: async (_invocation, next) => {
          events.push("transaction:before");
          try {
            return await next();
          } catch (error) {
            events.push("transaction:rollback");
            throw error;
          }
        },
        audit: {
          succeeded: () => {
            events.push("audit:success");
          },
          failed: (_invocation, error) => {
            events.push(`audit:failure:${error instanceof Error ? error.message : String(error)}`);
          },
        },
      },
    });

    const res = await testRequest(app, "/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "fail" }),
    });
    expect(res.status).toBe(500);
    expect(events).toEqual([
      "authorize",
      "idempotency:before",
      "transaction:before",
      "transaction:rollback",
      "audit:failure:create failed",
    ]);
  });

  test("fails during application construction without command governance", () => {
    expect(() => createTestApp({
      modules: [createAuditModule({}), createCaseModule({})],
    })).toThrow("has command routes but no commandGovernance");
  });

  test("fails closed when declared transaction governance is unavailable", async () => {
    const app = createApp({}, {
      commandGovernance: {
        authorize: () => {},
        idempotency: (_invocation, next) => next(),
        audit: { succeeded: () => {}, failed: () => {} },
      },
    });
    const res = await testRequest(app, "/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "blocked" }),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "COMMAND_TRANSACTION_UNAVAILABLE",
    });
  });

  test("enforces command-bound routes through the configured executor", async () => {
    const events: string[] = [];
    const app = createTestApp({
      modules: [createAuditModule({}), createCaseModule({})],
      requestContext: requestIdFromHeader,
      commandExecutor: async (invocation, next) => {
        events.push(`${invocation.command.name}:${invocation.command.permission}`);
        return next();
      },
    });

    const res = await testRequest(app, "/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "governed" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "case-1", title: "governed" });
    expect(events).toEqual(["case.create:case.create"]);
  });

  test("allows applications to map errors to their public envelope", async () => {
    const app = createApp({}, {
      commandGovernance: {
        ...passthroughGovernance,
        authorize: () => {
          throw new ApplicationError("case conflict", { status: 409, code: "CASE_CONFLICT" });
        },
      },
      errorMapper: (error, context) => Response.json({
        ok: false,
        code: context.frameworkCode,
        message: error instanceof Error ? error.message : String(error),
      }, { status: 409 }),
    });
    const res = await testRequest(app, "/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "blocked" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  test("executes module, route, command, governance, and handler in static onion order", async () => {
    const events: string[] = [];
    const around = (label: string) => async (
      _context: { kind: string },
      next: () => unknown | Promise<unknown>,
    ) => {
      events.push(`${label}:before`);
      const result = await next();
      events.push(`${label}:after`);
      return result;
    };
    const app = createTestApp({
      modules: [{
        name: "aop",
        aspects: [around("module")],
        createServices: () => ({
          controller: { run: () => {
            events.push("handler");
            return { ok: true };
          } },
        }),
        controllers: [{
          path: "/aop",
          serviceKey: "controller",
          scope: "application",
          routes: [{
            method: "POST",
            path: "/",
            handler: "run",
            aspects: [around("route")],
            command: "RunCommand",
          }],
        }],
        commands: [{
          className: "RunCommand",
          name: "aop.run",
          permission: "aop.run",
          transaction: "none",
          idempotency: "none",
          aspects: [around("command")],
        }],
      }],
      commandExecutor: async (_invocation, next) => {
        events.push("governance:before");
        const result = await next();
        events.push("governance:after");
        return result;
      },
    });

    const response = await testRequest(app, "/aop", { method: "POST" });
    expect(response.status).toBe(200);
    expect(events).toEqual([
      "module:before",
      "route:before",
      "command:before",
      "governance:before",
      "handler",
      "governance:after",
      "command:after",
      "route:after",
      "module:after",
    ]);
  });
});

describe("SupaCloud request context", () => {
  test("uses only the Edge Runtime verified subject and keeps tokens out of JSON", async () => {
    const request = new Request("https://example.test/cases", {
      headers: {
        authorization: "Bearer signed-token",
        "x-supacloud-jwt-sub": "user-42",
        "x-sb-execution-id": "exec-1",
        "idempotency-key": "idem-1",
      },
    });
    const context = await createSupaCloudRequestContext(request) as {
      requestId: string;
      identity: { authenticated: boolean; subject?: string; accessToken?: string };
      idempotencyKey?: string;
    };

    expect(context.requestId).toBe("exec-1");
    expect(context.identity).toMatchObject({ authenticated: true, subject: "user-42" });
    expect(context.identity.accessToken).toBe("signed-token");
    expect(context.idempotencyKey).toBe("idem-1");
    expect(JSON.stringify(context.identity)).not.toContain("signed-token");

    const identity = requireTrustedIdentity(context);
    expect(identity.subject).toBe("user-42");
    expect(Object.keys(identity)).not.toContain("accessToken");
  });

  test("requires both verified identity and bearer credentials", async () => {
    const anonymous = await createSupaCloudRequestContext(
      new Request("https://example.test/cases", {
        headers: { authorization: "Bearer unverified-token" },
      }),
    );
    expect(() => requireTrustedIdentity(anonymous)).toThrow("Authenticated user context is required");
  });

  test("requires an idempotency key for idempotent commands", async () => {
    const request = new Request("https://example.test/cases");
    const requestContext = await createSupaCloudRequestContext(request);
    expect(() => requireIdempotencyKey({
      command: {
        className: "CreateCaseCommand",
        name: "case.create",
        permission: "case.create",
        transaction: "required",
        idempotency: "required",
      },
      input: { body: {}, params: {}, query: {} },
      request,
      requestContext,
      services: {},
    })).toThrow("Idempotency-Key header is required");
  });
});

describe("defaultErrorResponse", () => {
  test("accepts structural public errors from platform packages", async () => {
    const error = Object.assign(new Error("Service role reason is not allowed"), {
      expose: true as const,
      status: 403,
      code: "SERVICE_ROLE_REASON_NOT_ALLOWED",
    });
    const response = defaultErrorResponse(error);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      code: "SERVICE_ROLE_REASON_NOT_ALLOWED",
      message: "Service role reason is not allowed",
    });
  });
});

describe("createModulePlugin", () => {
  test("works standalone on a plain Elysia app", async () => {
    const captured: Captured = {};
    const auditModule = createAuditModule(captured);
    const caseModule = createCaseModule(captured);

    const auditServices = auditModule.createServices({}, {});
    const caseServices = caseModule.createServices({}, { audit: auditServices });

    const app = new Elysia().use(
      createModulePlugin(caseModule, caseServices, requestIdFromHeader, {
        commandGovernance: passthroughGovernance,
      }),
    );

    const res = await testRequest(app, "/cases/9", {
      headers: { "x-request-id": "req-standalone" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "9",
      title: "Case 9",
      requestId: "req-standalone",
    });
    expect(captured.auditService?.entries).toEqual(["case.get:9"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(captured.requestScopeDestroyed).toBe(1);
  });
});

describe("composeCommandExecutors", () => {
  test("chains multiple executors in onion order", async () => {
    const trace: string[] = [];
    const pipeline = composeCommandExecutors(
      async (inv, next) => {
        trace.push(`outer:before:${inv.command.name}`);
        const res = await next();
        trace.push(`outer:after:${inv.command.name}`);
        return res;
      },
      null,
      async (inv, next) => {
        trace.push(`inner:before:${inv.command.name}`);
        const res = await next();
        trace.push(`inner:after:${inv.command.name}`);
        return res;
      },
      undefined,
    );

    const fakeInvocation = {
      command: { className: "Cmd", name: "test.cmd" },
      input: { body: {}, params: {}, query: {} },
      request: new Request("http://localhost"),
      requestContext: {},
      services: {},
    };

    const result = await pipeline(fakeInvocation, () => {
      trace.push("handler");
      return { ok: true };
    });

    expect(result).toEqual({ ok: true });
    expect(trace).toEqual([
      "outer:before:test.cmd",
      "inner:before:test.cmd",
      "handler",
      "inner:after:test.cmd",
      "outer:after:test.cmd",
    ]);
  });

  test("handles empty executors list as identity", async () => {
    const pipeline = composeCommandExecutors();
    const fakeInvocation = {
      command: { className: "Cmd", name: "test.cmd" },
      input: { body: {}, params: {}, query: {} },
      request: new Request("http://localhost"),
      requestContext: {},
      services: {},
    };
    const result = await pipeline(fakeInvocation, () => 123);
    expect(result).toBe(123);
  });

  test("short-circuits when an outer executor throws or rejects", async () => {
    const trace: string[] = [];
    const pipeline = composeCommandExecutors(
      async () => {
        trace.push("guard:rejected");
        throw new Error("unauthorized");
      },
      async (_inv, next) => {
        trace.push("inner");
        return next();
      },
    );

    const fakeInvocation = {
      command: { className: "Cmd", name: "test.cmd" },
      input: { body: {}, params: {}, query: {} },
      request: new Request("http://localhost"),
      requestContext: {},
      services: {},
    };

    expect(pipeline(fakeInvocation, () => {
      trace.push("handler");
      return { ok: true };
    })).rejects.toThrow("unauthorized");
    expect(trace).toEqual(["guard:rejected"]);
  });

  test("rejects multiple next() calls in the same executor", async () => {
    const pipeline = composeCommandExecutors(async (_inv, next) => {
      await next();
      return next();
    });

    const fakeInvocation = {
      command: { className: "Cmd", name: "test.cmd" },
      input: { body: {}, params: {}, query: {} },
      request: new Request("http://localhost"),
      requestContext: {},
      services: {},
    };

    expect(pipeline(fakeInvocation, () => "ok")).rejects.toThrow(
      "next() called multiple times",
    );
  });

  test("works inside createApplication with pipeline middleware", async () => {
    const logs: string[] = [];
    const app = createApp({}, {
      commandExecutor: composeCommandExecutors(
        async (invocation, next) => {
          logs.push(`auth:${invocation.command.permission}`);
          return next();
        },
        async (invocation, next) => {
          logs.push(`audit:start:${invocation.command.audit}`);
          const result = await next();
          logs.push(`audit:end:${invocation.command.audit}`);
          return result;
        },
      ),
    });

    const res = await testRequest(app, "/cases", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "pipelined" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "case-1", title: "pipelined" });
    expect(logs).toEqual([
      "auth:case.create",
      "audit:start:case.created",
      "audit:end:case.created",
    ]);
  });

  test("supports HEAD and OPTIONS route methods", async () => {
    const app = createApplication({
      modules: [
        {
          name: "status",
          createServices: () => ({
            statusController: {
              headCheck: () => new Response(null, { status: 200 }),
              optionsCheck: () => new Response(null, { status: 204, headers: { allow: "GET, HEAD, OPTIONS" } }),
            },
          }),
          controllers: [
            {
              path: "/status",
              serviceKey: "statusController",
              scope: "application",
              routes: [
                { method: "HEAD", path: "", handler: "headCheck" },
                { method: "OPTIONS", path: "", handler: "optionsCheck" },
              ],
            },
          ],
        },
      ],
    });

    const headRes = await testRequest(app, "/status", { method: "HEAD" });
    expect(headRes.status).toBe(200);

    const optRes = await testRequest(app, "/status", { method: "OPTIONS" });
    expect(optRes.status).toBe(204);
    expect(optRes.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});

describe("composeAspects and executeJob", () => {
  test("rejects repeated next() calls", async () => {
    const pipeline = composeAspects(async (_context, next) => {
      await next();
      return next();
    });
    await expect(pipeline({
      kind: "route",
      name: "test",
      input: {},
    }, () => "ok")).rejects.toThrow("next() called multiple times");
  });

  test("executes a job with static aspects and destroys its job scope", async () => {
    const events: string[] = [];
    let destroyed = 0;
    const aspect = async (
      context: { kind: string; name: string },
      next: () => unknown | Promise<unknown>,
    ) => {
      events.push(`${context.kind}:${context.name}:before`);
      const result = await next();
      events.push(`${context.kind}:${context.name}:after`);
      return result;
    };
    const compiled: CompiledModule = {
      name: "jobs",
      createServices: () => ({}),
      createJobScope: () => ({
        rebuildJob: {
          run: (input: { id: string }) => {
            events.push(`run:${input.id}`);
            return input.id;
          },
        },
      }),
      destroyJobScope: async () => {
        destroyed += 1;
      },
      controllers: [],
      commands: [],
      jobs: [{
        className: "RebuildJob",
        name: "case.rebuild",
        serviceKey: "rebuildJob",
        scope: "job",
        aspects: [aspect],
      }],
      aspects: [aspect],
    };

    const result = await executeJob(
      compiled,
      {},
      compiled.jobs?.[0] ?? (() => {
        throw new Error("job fixture is missing");
      })(),
      { id: "42" },
      { jobId: "j-1" },
    );
    expect(result).toBe("42");
    expect(events).toEqual([
      "job:case.rebuild:before",
      "job:case.rebuild:before",
      "run:42",
      "job:case.rebuild:after",
      "job:case.rebuild:after",
    ]);
    expect(destroyed).toBe(1);
  });

  test("destroys a job scope when the handler is unavailable", async () => {
    let destroyed = 0;
    const compiled: CompiledModule = {
      name: "jobs",
      createServices: () => ({}),
      createJobScope: () => ({}),
      destroyJobScope: async () => {
        destroyed += 1;
      },
      controllers: [],
      commands: [],
      jobs: [],
    };

    await expect(executeJob(
      compiled,
      {},
      {
        className: "BrokenJob",
        name: "case.broken",
        serviceKey: "brokenJob",
        scope: "job",
      },
      {},
      {},
    )).rejects.toMatchObject({ code: "JOB_HANDLER_UNAVAILABLE" });
    expect(destroyed).toBe(1);
  });

  test("does not create or destroy a job scope for an application-scoped job", async () => {
    let created = 0;
    let destroyed = 0;
    const compiled: CompiledModule = {
      name: "jobs",
      createServices: () => ({
        applicationJob: {
          run: (input: string) => input.toUpperCase(),
        },
      }),
      createJobScope: () => {
        created += 1;
        return {};
      },
      destroyJobScope: async () => {
        destroyed += 1;
      },
      controllers: [],
      commands: [],
      jobs: [],
    };

    await expect(executeJob(
      compiled,
      compiled.createServices({}, {}),
      {
        className: "ApplicationJob",
        name: "case.application",
        serviceKey: "applicationJob",
        scope: "application",
      },
      "ok",
      {},
    )).resolves.toBe("OK");
    expect(created).toBe(0);
    expect(destroyed).toBe(0);
  });
});
