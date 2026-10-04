import { expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "./supabase-types.js";
import { createSupaCloudApiFetch } from "./api-fetch.js";

type InvokeOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  signal?: AbortSignal;
};

test("Supabase API fetch reuses functions.invoke and strips caller auth headers", async () => {
  const calls: Array<{ name: string; options: InvokeOptions | undefined }> = [];
  const supabase = {
    functions: {
      invoke: async (name: string, options?: InvokeOptions) => {
        calls.push({ name, options });
        return { data: { ok: true }, error: null };
      },
    },
  } as unknown as SupabaseClient;
  const fetcher = createSupaCloudApiFetch({ supabase, functionName: "app-api" });

  const response = await fetcher("/cases/case-1?full=true", {
    method: "POST",
    headers: {
      authorization: "Bearer stale",
      apikey: "stale",
      "idempotency-key": "case-1-v1",
      "content-type": "application/json",
    },
    body: JSON.stringify({ reason: "approved" }),
  });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
  expect(calls).toEqual([{
    name: "app-api/cases/case-1?full=true",
    options: {
      body: { reason: "approved" },
      headers: { "content-type": "application/json", "idempotency-key": "case-1-v1" },
      method: "POST",
      signal: expect.any(AbortSignal),
    },
  }]);
});

test("Supabase API fetch composes with the official Supabase client transport", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const supabase = createClient("https://project.example.com", "publishable-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (input, init) => {
        requests.push({ url: input.toString(), init });
        return Response.json({ ok: true }, {
          status: 201,
          headers: { "x-request-id": "req-official-client" },
        });
      },
    },
  });
  const fetcher = createSupaCloudApiFetch({ supabase, functionName: "app-api" });

  const response = await fetcher("/cases?full=true", {
    method: "POST",
    headers: {
      authorization: "Bearer caller-value",
      apikey: "caller-value",
      "x-tenant": "tenant-1",
    },
    body: JSON.stringify({ reason: "approved" }),
  });

  const request = requests[0];
  expect(request?.url).toBe("https://project.example.com/functions/v1/app-api/cases?full=true");
  expect(request?.init?.method).toBe("POST");
  expect(new Headers(request?.init?.headers).get("x-tenant")).toBe("tenant-1");
  expect(new Headers(request?.init?.headers).get("apikey")).toBe("publishable-key");
  expect(new Headers(request?.init?.headers).get("authorization")).not.toBe("Bearer caller-value");
  await expect(new Response(request?.init?.body).json()).resolves.toEqual({ reason: "approved" });
  expect(response.status).toBe(201);
  expect(response.headers.get("x-request-id")).toBe("req-official-client");
});

test("Supabase API fetch preserves the Functions HTTP response on errors", async () => {
  const response = Response.json({ code: "FORBIDDEN" }, { status: 403 });
  const supabase = {
    functions: {
      invoke: async () => ({
        data: null,
        error: new Error("forbidden"),
        response,
      }),
    },
  } as unknown as SupabaseClient;
  const fetcher = createSupaCloudApiFetch({ supabase, functionName: "app-api" });

  const result = await fetcher("/cases", { method: "GET" });

  expect(result).toBe(response);
  expect(result.status).toBe(403);
  await expect(result.json()).resolves.toEqual({ code: "FORBIDDEN" });
});

test("Supabase API fetch preserves successful status and response headers", async () => {
  const supabase = {
    functions: {
      invoke: async () => ({
        data: { taskId: "task-1" },
        error: null,
        response: Response.json(
          { taskId: "task-1" },
          { status: 202, headers: { "x-request-id": "req-1" } },
        ),
      }),
    },
  } as unknown as SupabaseClient;
  const fetcher = createSupaCloudApiFetch({ supabase, functionName: "app-api" });

  const result = await fetcher("/cases", { method: "POST" });

  expect(result.status).toBe(202);
  expect(result.headers.get("x-request-id")).toBe("req-1");
  await expect(result.json()).resolves.toEqual({ taskId: "task-1" });
});

test("Supabase API fetch reconstructs empty successful responses", async () => {
  const supabase = {
    functions: {
      invoke: async () => ({
        data: "",
        error: null,
        response: new Response(null, { status: 204 }),
      }),
    },
  } as unknown as SupabaseClient;
  const fetcher = createSupaCloudApiFetch({ supabase, functionName: "app-api" });

  const result = await fetcher("/cases/case-1", { method: "DELETE" });

  expect(result.status).toBe(204);
  await expect(result.text()).resolves.toBe("");
});
