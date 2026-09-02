import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import {
  createApplication,
  createModulePlugin,
  createTestApp,
  type ApplicationOptions,
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
}

function createAuditModule(captured: Captured): CompiledModule {
  return {
    name: "audit",
    createServices: () => {
      captured.auditService = new AuditService();
      return { auditService: captured.auditService };
    },
    controllers: [],
  };
}

class CaseService {
  constructor(private readonly audit: AuditService) {}

  findById(id: string): { id: string; title: string } {
    this.audit.record(`case.get:${id}`);
    return { id, title: `Case ${id}` };
  }

  create(input: { title: string }): { id: string; title: string } {
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
          },
        ],
      },
    ],
  };
}

const requestIdFromHeader: ApplicationOptions["requestContext"] = (request) => ({
  requestId: request.headers.get("x-request-id") ?? "anonymous",
  request,
});

function createApp(captured: Captured, options?: Partial<ApplicationOptions>) {
  return createTestApp({
    modules: [createAuditModule(captured), createCaseModule(captured)],
    requestContext: requestIdFromHeader,
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
});

describe("createModulePlugin", () => {
  test("works standalone on a plain Elysia app", async () => {
    const captured: Captured = {};
    const auditModule = createAuditModule(captured);
    const caseModule = createCaseModule(captured);

    const auditServices = auditModule.createServices({}, {});
    const caseServices = caseModule.createServices({}, { audit: auditServices });

    const app = new Elysia().use(
      createModulePlugin(caseModule, caseServices, requestIdFromHeader),
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
  });
});
