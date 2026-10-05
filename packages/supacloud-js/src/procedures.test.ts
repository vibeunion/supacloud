import { describe, expect, test } from "bun:test";
import {
  createSupaCloudClient,
  createProcedureClient,
  createQueryAdapter,
  createQueryKey,
  invalidateByTags,
} from "./index.js";

describe("SupaCloud Procedure Client and Query Adapter Extensions", () => {
  const mockSupabase = {
    supabaseUrl: "https://project.supabase.co",
    supabaseKey: "anon-key",
    auth: {
      getSession: async () => ({
        data: { session: null },
        error: null,
      }),
    },
    rpc: async () => ({ data: null, error: null }),
  } as any;

  const mockApiClient = {
    procedures: {
      cases: {
        getDetail: Object.assign(
          async (input?: any) => ({ id: input?.caseId, name: "Test Case" }),
          {
            operationId: "cases.getDetail",
            kind: "query" as const,
            tags: ["cases"],
            query: async (input?: any) => ({ id: input?.caseId, name: "Test Case" }),
          },
        ),
        accept: Object.assign(
          async (input?: any, options?: any) => ({
            accepted: true,
            caseId: input?.caseId,
            key: options?.idempotencyKey,
          }),
          {
            operationId: "cases.accept",
            kind: "command" as const,
            tags: ["cases"],
            commandName: "case.accept",
            idempotency: "required" as const,
            mutate: async (input?: any, options?: any) => ({
              accepted: true,
              caseId: input?.caseId,
              key: options?.idempotencyKey,
            }),
          },
        ),
      },
    },
  };

  test("createSupaCloudClient attaches procedures when apiClient is provided", async () => {
    const client = createSupaCloudClient({
      supabase: mockSupabase,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj123",
      apiClient: mockApiClient,
    });

    expect(client.procedures).toBeDefined();

    // Query procedure
    const queryResult = await client.procedures!.cases.getDetail.query({ caseId: "case-1" });
    expect(queryResult).toEqual({ id: "case-1", name: "Test Case" });

    // Mutation procedure
    const mutateResult = await client.procedures!.cases.accept.mutate(
      { caseId: "case-1" },
      { idempotencyKey: "idem-key-123" },
    );
    expect(mutateResult).toEqual({
      accepted: true,
      caseId: "case-1",
      key: "idem-key-123",
    });

    // Query adapter via client.queryAdapter()
    const query = client.queryAdapter();
    const qKey = query.cases.getDetail.queryKey({ caseId: "c1" });
    expect(qKey).toEqual(["cases.getDetail", { caseId: "c1" }]);

    const qOpts = query.cases.getDetail.queryOptions({ caseId: "c1" });
    expect(qOpts.queryKey).toEqual(qKey);
    const loaded = await qOpts.queryFn({});
    expect(loaded).toEqual({ id: "c1", name: "Test Case" });
  });

  test("withClient fluent builder attaches procedures to existing client", async () => {
    const baseClient = createSupaCloudClient({
      supabase: mockSupabase,
      managementApiUrl: "https://admin.example.com",
      projectRef: "proj123",
    });

    expect(baseClient.procedures).toBeUndefined();
    expect(() => baseClient.queryAdapter()).toThrow("No procedure client attached");

    const clientWithProcedures = baseClient.withClient(mockApiClient);
    expect(clientWithProcedures.procedures).toBeDefined();

    const result = await clientWithProcedures.procedures.cases.getDetail.query({ caseId: "c42" });
    expect(result).toEqual({ id: "c42", name: "Test Case" });

    const adapter = clientWithProcedures.queryAdapter();
    expect(typeof adapter.cases.accept.mutationOptions).toBe("function");
  });

  test("re-exported query adapter helpers function identically", async () => {
    const key = createQueryKey("cases.getDetail", { id: "123" });
    expect(key).toEqual(["cases.getDetail", { id: "123" }]);

    const adapter = createQueryAdapter(mockApiClient.procedures);
    expect(adapter.cases.getDetail.queryKey({ caseId: "c5" })).toEqual([
      "cases.getDetail",
      { caseId: "c5" },
    ]);

    const invalidated: string[] = [];
    const mockQueryClient = {
      invalidateQueries: async ({ predicate }: any) => {
        if (predicate({ meta: { tags: ["cases"] } })) {
          invalidated.push("cases");
        }
      },
    };

    await invalidateByTags(mockQueryClient, ["cases"]);
    expect(invalidated).toEqual(["cases"]);
  });

  test("createProcedureClient unwraps procedures façade", () => {
    const procedures = createProcedureClient(mockApiClient);
    expect(procedures).toBe(mockApiClient.procedures);

    const direct = createProcedureClient(mockApiClient.procedures);
    expect(direct).toBe(mockApiClient.procedures);
  });
});
