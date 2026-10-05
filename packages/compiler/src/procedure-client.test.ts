import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderClient } from "./generate";
import type { ApplicationGraph } from "./types";
import { writeFixtureProject } from "./fixtures/helpers";
import { createQueryAdapter } from "../../query/src";

const testGraph: ApplicationGraph = {
  externalTokens: [],
  modules: [
    {
      name: "cases",
      className: "CasesModule",
      file: "src/cases.module.ts",
      line: 1,
      imports: [],
      providers: [],
      commands: [
        {
          className: "AcceptCaseCommand",
          name: "case.accept",
          permission: "case:accept",
          transaction: "required",
          idempotency: "required",
          audit: "case.accepted",
        },
      ],
      queries: [],
      exports: [],
      controllers: [
        {
          className: "CasesController",
          path: "/tenants/:tenantId/cases",
          scope: "request",
          deps: [],
          file: "src/cases.controller.ts",
          importPath: "src/cases.controller",
          schemaImports: {
            CaseDetail: "src/contracts",
            CaseAcceptInput: "src/contracts",
            CaseAcceptResult: "src/contracts",
          },
          routes: [
            {
              method: "GET",
              path: "/:caseId",
              handler: "getDetail",
              pathParams: ["caseId"],
              queryBindings: ["fields"],
              response: "CaseDetail",
            },
            {
              method: "POST",
              path: "/:caseId/accept",
              handler: "accept",
              pathParams: ["caseId"],
              body: "CaseAcceptInput",
              response: "CaseAcceptResult",
              command: "AcceptCaseCommand",
            },
          ],
        },
      ],
    },
  ],
};

describe("Procedure Client and Operation IR", () => {
  test("generates API_OPERATIONS with operation metadata and idempotency requirements", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-proc-client-"));
    try {
      await writeFixtureProject(root, {
        "generated/client.ts": renderClient(testGraph, {
          rootDir: root,
          outDir: join(root, "generated"),
        }),
        "src/contracts.ts": [
          'export const CaseDetail = { type: "object", properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id"] };',
          'export const CaseAcceptInput = { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] };',
          'export const CaseAcceptResult = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] };',
        ].join("\n"),
      });

      const clientModule = await import(pathToFileURL(join(root, "generated/client.ts")).href);
      const operations = clientModule.API_OPERATIONS;

      expect(Array.isArray(operations)).toBe(true);
      expect(operations.length).toBe(2);

      const getOp = operations.find((op: any) => op.operationId === "cases.getDetail");
      expect(getOp).toBeDefined();
      expect(getOp.kind).toBe("query");
      expect(getOp.controllerKey).toBe("cases");
      expect(getOp.handler).toBe("getDetail");
      expect(getOp.method).toBe("GET");
      expect(getOp.cacheTags).toContain("cases");

      const acceptOp = operations.find((op: any) => op.operationId === "cases.accept");
      expect(acceptOp).toBeDefined();
      expect(acceptOp.kind).toBe("command");
      expect(acceptOp.commandName).toBe("case.accept");
      expect(acceptOp.permission).toBe("case:accept");
      expect(acceptOp.idempotency).toBe("required");
      expect(acceptOp.audit).toBe("case.accepted");
      expect(acceptOp.cacheTags).toContain("cases");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("procedure façade supports flat input mapping while preserving REST client", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-proc-runtime-"));
    try {
      await writeFixtureProject(root, {
        "generated/client.ts": renderClient(testGraph, {
          rootDir: root,
          outDir: join(root, "generated"),
        }),
        "src/contracts.ts": [
          'export const CaseDetail = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };',
          'export const CaseAcceptInput = { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] };',
          'export const CaseAcceptResult = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] };',
        ].join("\n"),
      });

      const clientModule = await import(pathToFileURL(join(root, "generated/client.ts")).href);
      let lastUrl = "";
      let lastMethod = "";
      let lastHeaders: Record<string, string> = {};
      let lastBody: unknown = undefined;

      const client = clientModule.createApiClient({
        baseUrl: "https://api.example.com",
        fetch: async (url: string, init: any) => {
          lastUrl = url;
          lastMethod = init.method;
          lastHeaders = init.headers ?? {};
          lastBody = init.body ? JSON.parse(init.body) : undefined;
          if (init.method === "GET") {
            return Response.json({ id: "case-123" });
          }
          return Response.json({ accepted: true });
        },
      });

      // 1. Existing REST client continues to work 100% backward-compatibly
      const restResult = await client.cases.getDetail({
        params: { tenantId: "t1", caseId: "c1" },
        query: { fields: "all" },
      });
      expect(restResult).toEqual({ id: "case-123" });
      expect(lastUrl).toBe("https://api.example.com/tenants/t1/cases/c1?fields=all");

      // 2. Procedure Query: flat input { tenantId, caseId, fields }
      const procQueryResult = await client.procedures.cases.getDetail.query({
        tenantId: "t1",
        caseId: "c2",
        fields: "summary",
      });
      expect(procQueryResult).toEqual({ id: "case-123" });
      expect(lastUrl).toBe("https://api.example.com/tenants/t1/cases/c2?fields=summary");

      // 3. Dual helper on the controller method itself
      const dualQueryResult = await client.cases.getDetail.query({
        tenantId: "t1",
        caseId: "c3",
      });
      expect(dualQueryResult).toEqual({ id: "case-123" });
      expect(lastUrl).toBe("https://api.example.com/tenants/t1/cases/c3");

      // 4. Procedure Mutation: flat input { tenantId, caseId, reason } with required idempotencyKey
      const mutateResult = await client.procedures.cases.accept.mutate(
        {
          tenantId: "t1",
          caseId: "c1",
          reason: "approved by supervisor",
        },
        {
          idempotencyKey: "biz-attempt-9876",
        },
      );
      expect(mutateResult).toEqual({ accepted: true });
      expect(lastMethod).toBe("POST");
      expect(lastUrl).toBe("https://api.example.com/tenants/t1/cases/c1/accept");
      expect(lastBody).toEqual({ reason: "approved by supervisor" });
      expect(lastHeaders["idempotency-key"]).toBe("biz-attempt-9876");
      expect(lastHeaders["x-idempotency-key"]).toBe("biz-attempt-9876");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("strictly requires explicit idempotencyKey for idempotent commands and reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-idempotency-test-"));
    try {
      await writeFixtureProject(root, {
        "generated/client.ts": renderClient(testGraph, {
          rootDir: root,
          outDir: join(root, "generated"),
        }),
        "src/contracts.ts": [
          'export const CaseDetail = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };',
          'export const CaseAcceptInput = { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] };',
          'export const CaseAcceptResult = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] };',
        ].join("\n"),
      });

      const clientModule = await import(pathToFileURL(join(root, "generated/client.ts")).href);
      const client = clientModule.createApiClient({
        baseUrl: "https://api.example.com",
        fetch: async () => Response.json({ accepted: true }),
      });

      // 1. Missing idempotencyKey must throw API_MISSING_IDEMPOTENCY_KEY without silent random generation
      let errorThrown: any = null;
      try {
        await client.procedures.cases.accept.mutate({
          tenantId: "t1",
          caseId: "c1",
          reason: "test",
        });
      } catch (err) {
        errorThrown = err;
      }
      expect(errorThrown).toBeDefined();
      expect(errorThrown.code).toBe("API_MISSING_IDEMPOTENCY_KEY");
      expect(errorThrown.message).toContain("case.accept");

      // 2. Caller-supplied key is retained and stable across retries
      const attemptKey = "order-attempt-uuid-12345";
      const recordedKeys: string[] = [];

      const retryClient = clientModule.createApiClient({
        baseUrl: "https://api.example.com",
        fetch: async (_url: string, init: any) => {
          recordedKeys.push(init.headers["idempotency-key"]);
          return Response.json({ accepted: true });
        },
      });

      // Attempt 1
      await retryClient.procedures.cases.accept.mutate(
        { tenantId: "t1", caseId: "c1", reason: "test" },
        { idempotencyKey: attemptKey },
      );
      // Attempt 2 (simulating retry of same business attempt)
      await retryClient.procedures.cases.accept.mutate(
        { tenantId: "t1", caseId: "c1", reason: "test" },
        { idempotencyKey: attemptKey },
      );

      expect(recordedKeys.length).toBe(2);
      expect(recordedKeys[0]).toBe(attemptKey);
      expect(recordedKeys[1]).toBe(attemptKey);
      // Verify both attempts reused the exact same key without alteration
      expect(recordedKeys[0]).toBe(recordedKeys[1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("integrates seamlessly with @supacloud/query adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-query-integ-"));
    try {
      await writeFixtureProject(root, {
        "generated/client.ts": renderClient(testGraph, {
          rootDir: root,
          outDir: join(root, "generated"),
        }),
        "src/contracts.ts": [
          'export const CaseDetail = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };',
          'export const CaseAcceptInput = { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] };',
          'export const CaseAcceptResult = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] };',
        ].join("\n"),
      });

      const clientModule = await import(pathToFileURL(join(root, "generated/client.ts")).href);
      const client = clientModule.createApiClient({
        baseUrl: "https://api.example.com",
        fetch: async () => Response.json({ id: "case-999" }),
      });

      const api = createQueryAdapter(client);

      // Verify queryKey generation on generated client
      const qKey = api.cases.getDetail.queryKey({ tenantId: "t1", caseId: "c99" });
      expect(qKey).toEqual(["cases.getDetail", { caseId: "c99", tenantId: "t1" }]);

      // Verify queryOptions
      const qOpts = api.cases.getDetail.queryOptions({ tenantId: "t1", caseId: "c99" });
      expect(qOpts.queryKey).toEqual(qKey);
      expect(qOpts.meta?.tags).toEqual(["cases"]);

      const queryData = await qOpts.queryFn({});
      expect(queryData).toEqual({ id: "case-999" });

      // Verify mutationOptions
      const mOpts = api.cases.accept.mutationOptions();
      expect(mOpts.mutationKey).toEqual(["cases.accept"]);
      expect(mOpts.meta?.tags).toEqual(["cases"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("createApiClient integrates seamlessly with supabase-js client", async () => {
    const root = await mkdtemp(join(tmpdir(), "supacloud-supabase-test-"));
    try {
      await writeFixtureProject(root, {
        "generated/client.ts": renderClient(testGraph, {
          rootDir: root,
          outDir: join(root, "generated"),
        }),
        "src/contracts.ts": [
          'export const CaseDetail = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };',
          'export const CaseAcceptInput = { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] };',
          'export const CaseAcceptResult = { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"] };',
        ].join("\n"),
      });

      const clientModule = await import(pathToFileURL(join(root, "generated/client.ts")).href);

      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};

      const mockSupabase = {
        supabaseUrl: "https://mock.supabase.co",
        functionsUrl: "https://mock.supabase.co/functions/v1",
        supabaseKey: "anon-key-xyz",
        auth: {
          getSession: async () => ({
            data: {
              session: {
                access_token: "jwt-user-token-789",
              },
            },
            error: null,
          }),
        },
      };

      const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = String(input);
        const headers = init?.headers;
        if (headers instanceof Headers) {
          capturedHeaders = Object.fromEntries(headers.entries());
        } else if (headers && typeof headers === "object") {
          capturedHeaders = { ...(headers as Record<string, string>) };
        }
        return Response.json({ id: "case-mock" });
      };

      // 1. Initializing via createApiClient({ supabase, fetch })
      const client = clientModule.createApiClient({
        supabase: mockSupabase,
        fetch: mockFetch,
      });

      const detail = await client.cases.getDetail.query({
        tenantId: "tenant-100",
        caseId: "case-200",
      });

      expect(detail).toEqual({ id: "case-mock" });
      expect(capturedUrl).toBe("https://mock.supabase.co/functions/v1/tenants/tenant-100/cases/case-200");
      expect(capturedHeaders["apikey"]).toBe("anon-key-xyz");
      expect(capturedHeaders["authorization"]).toBe("Bearer jwt-user-token-789");

      // 2. Initializing via createApiClientFromSupabase
      const clientFromSupabase = clientModule.createApiClientFromSupabase(mockSupabase, {
        fetch: mockFetch,
      });
      await clientFromSupabase.cases.getDetail({
        params: { tenantId: "tenant-100", caseId: "case-300" },
      });
      expect(capturedUrl).toBe("https://mock.supabase.co/functions/v1/tenants/tenant-100/cases/case-300");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
