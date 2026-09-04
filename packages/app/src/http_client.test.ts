import { describe, expect, test } from "bun:test";
import { HttpParams } from "./http_params";
import { HttpHeaders } from "./http_headers";
import { HttpContext, HttpContextToken } from "./http_context";
import {
  HttpClient,
  HttpErrorResponse,
  HTTP_CLIENT_CONFIG,
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withFetch,
  withInterceptors,
} from "./http_client";
import { createEnvironmentInjector } from "./inject";
import { TestBed } from "./testing";

describe("Angular-inspired HttpParams and HttpHeaders", () => {
  test("HttpParams provides immutable query parameter construction", () => {
    const params = new HttpParams({ fromString: "filter=active&sort=desc&tag=a&tag=b" });
    expect(params.get("filter")).toBe("active");
    expect(params.get("sort")).toBe("desc");
    expect(params.getAll("tag")).toEqual(["a", "b"]);
    expect(params.has("sort")).toBe(true);
    expect(params.has("unknown")).toBe(false);

    // Immutability check: set returns a new instance
    const updated = params.set("sort", "asc");
    expect(params.get("sort")).toBe("desc");
    expect(updated.get("sort")).toBe("asc");

    // append adds a value to the key
    const appended = updated.append("tag", "c");
    expect(appended.getAll("tag")).toEqual(["a", "b", "c"]);
    expect(updated.getAll("tag")).toEqual(["a", "b"]);

    // delete removes a specific value or the entire key
    const deletedValue = appended.delete("tag", "b");
    expect(deletedValue.getAll("tag")).toEqual(["a", "c"]);

    const deletedKey = deletedValue.delete("filter");
    expect(deletedKey.has("filter")).toBe(false);
    expect(deletedValue.has("filter")).toBe(true);

    // construction fromObject
    const fromObj = new HttpParams({
      fromObject: {
        page: 1,
        active: true,
        ids: ["10", "20"],
      },
    });
    expect(fromObj.get("page")).toBe("1");
    expect(fromObj.get("active")).toBe("true");
    expect(fromObj.getAll("ids")).toEqual(["10", "20"]);
    expect(fromObj.toString()).toBe("page=1&active=true&ids=10&ids=20");
  });

  test("HttpHeaders provides immutable case-insensitive HTTP header management", () => {
    const headers = new HttpHeaders({
      "Content-Type": "application/json",
      "X-Custom-Header": "value1",
    });

    expect(headers.has("content-type")).toBe(true);
    expect(headers.has("CONTENT-TYPE")).toBe(true);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-custom-header")).toBe("value1");

    // Immutability check: set returns new instance
    const updated = headers.set("Authorization", "Bearer secret");
    expect(headers.has("authorization")).toBe(false);
    expect(updated.has("authorization")).toBe(true);
    expect(updated.get("authorization")).toBe("Bearer secret");

    // append combines header values
    const appended = updated.append("Accept", "text/html").append("Accept", "application/xhtml+xml");
    expect(appended.getAll("accept")).toEqual(["text/html", "application/xhtml+xml"]);
    expect(appended.toObject()["Accept"]).toBe("text/html, application/xhtml+xml");

    // delete removes header case-insensitively
    const deleted = appended.delete("x-custom-header");
    expect(deleted.has("x-custom-header")).toBe(false);
    expect(appended.has("x-custom-header")).toBe(true);
  });

  test("HttpContext and HttpContextToken store strongly-typed request metadata", () => {
    const IS_CACHE_ENABLED = new HttpContextToken<boolean>(() => true);
    const RETRY_COUNT = new HttpContextToken<number>(() => 3);

    const context = new HttpContext();
    expect(context.get(IS_CACHE_ENABLED)).toBe(true);
    expect(context.get(RETRY_COUNT)).toBe(3);
    expect(context.has(IS_CACHE_ENABLED)).toBe(false);

    context.set(RETRY_COUNT, 5);
    expect(context.has(RETRY_COUNT)).toBe(true);
    expect(context.get(RETRY_COUNT)).toBe(5);

    context.delete(RETRY_COUNT);
    expect(context.has(RETRY_COUNT)).toBe(false);
    expect(context.get(RETRY_COUNT)).toBe(3);
  });
});

describe("Angular 15+ provideHttpClient and HttpClient", () => {
  test("executes GET requests through mock fetch and functional interceptors", async () => {
    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toBe("https://api.supacloud.dev/users?role=admin");
      const reqHeaders = (init?.headers as Record<string, string>) ?? {};
      expect(reqHeaders["authorization"]).toBe("Bearer test-token");
      return new Response(JSON.stringify([{ id: 1, name: "Admin" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const authInterceptor = async (req: any, next: any) => {
      req.headers["authorization"] = "Bearer test-token";
      return next(req);
    };

    const env = createEnvironmentInjector([
      provideHttpClient(
        withFetch(mockFetch as any),
        withInterceptors(authInterceptor),
      ),
    ]);

    const client = env.get(HttpClient);
    expect(client).toBeDefined();

    const users = await client.get<Array<{ id: number; name: string }>>(
      "https://api.supacloud.dev/users",
      {
        params: { role: "admin" },
      },
    );

    expect(users).toEqual([{ id: 1, name: "Admin" }]);
  });

  test("executes POST, PUT, DELETE, and PATCH requests with JSON bodies and params", async () => {
    let lastMethod = "";
    let lastBody = "";
    let lastUrl = "";

    const mockFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      lastUrl = String(input);
      lastMethod = init?.method ?? "GET";
      lastBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ success: true, method: lastMethod }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = new HttpClient(
      { baseUrl: "https://api.supacloud.dev/v1", fetch: mockFetch as any },
      [],
    );

    const postRes = await client.post<{ success: boolean; method: string }>(
      "items",
      { title: "Item 1" },
    );
    expect(postRes.success).toBe(true);
    expect(lastMethod).toBe("POST");
    expect(lastUrl).toBe("https://api.supacloud.dev/v1/items");
    expect(JSON.parse(lastBody)).toEqual({ title: "Item 1" });

    const putRes = await client.put<{ success: boolean; method: string }>(
      "/items/123",
      { title: "Item 1 Updated" },
    );
    expect(putRes.method).toBe("PUT");
    expect(lastUrl).toBe("https://api.supacloud.dev/v1/items/123");

    const patchRes = await client.patch<{ success: boolean; method: string }>(
      "/items/123",
      { active: false },
    );
    expect(patchRes.method).toBe("PATCH");

    const deleteRes = await client.delete<{ success: boolean; method: string }>(
      "/items/123",
    );
    expect(deleteRes.method).toBe("DELETE");
  });

  test("throws HttpErrorResponse on non-2xx HTTP responses", async () => {
    const mockFetch = async () => {
      return new Response(JSON.stringify({ message: "Not Found", code: "NOT_FOUND" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" },
      });
    };

    const client = new HttpClient({ fetch: mockFetch as any }, []);

    try {
      await client.get("https://api.supacloud.dev/unknown");
      expect(true).toBe(false);
    } catch (err) {
      expect(err instanceof HttpErrorResponse).toBe(true);
      const httpErr = err as HttpErrorResponse;
      expect(httpErr.status).toBe(404);
      expect(httpErr.statusText).toBe("Not Found");
      expect(httpErr.error).toEqual({ message: "Not Found", code: "NOT_FOUND" });
    }
  });

  test("supports observe: 'response' and HttpContext in interceptor", async () => {
    const SKIP_AUTH = new HttpContextToken<boolean>(() => false);
    let interceptorSawSkipAuth = false;

    const mockFetch = async () => {
      return new Response("OK", {
        status: 200,
        headers: { "x-total-count": "42" },
      });
    };

    const contextInterceptor = async (req: any, next: any) => {
      if (req.context?.get(SKIP_AUTH)) {
        interceptorSawSkipAuth = true;
      }
      return next(req);
    };

    const client = new HttpClient({ fetch: mockFetch as any }, [contextInterceptor]);
    const ctx = new HttpContext().set(SKIP_AUTH, true);

    const response = await client.get<Response>("https://api.supacloud.dev/status", {
      context: ctx,
      observe: "response",
    });

    expect(interceptorSawSkipAuth).toBe(true);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-total-count")).toBe("42");
    expect(await response.text()).toBe("OK");
  });
});
