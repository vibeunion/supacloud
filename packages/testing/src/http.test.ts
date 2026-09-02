import { describe, expect, test } from "bun:test";
import { testJson, testJsonError, testRequest } from "./http";
import type { HandleLike } from "./http";

/** Echo handle: reports the request method and URL as JSON. */
function echoApp(status = 200): HandleLike {
  return {
    handle(request: Request): Response {
      return Response.json(
        { method: request.method, url: request.url },
        { status },
      );
    },
  };
}

describe("testRequest", () => {
  test("dispatches a GET request and returns the response", async () => {
    const response = await testRequest(echoApp(), "/cases");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { method: string; url: string };
    expect(body.method).toBe("GET");
    expect(body.url).toBe("http://localhost/cases");
  });

  test("forwards method and body from init", async () => {
    const response = await testRequest(echoApp(), "/cases", {
      method: "POST",
      body: JSON.stringify({ title: "hello" }),
    });
    const body = (await response.json()) as { method: string };
    expect(body.method).toBe("POST");
  });
});

describe("testJson", () => {
  test("returns status and parsed body", async () => {
    const { status, body } = await testJson<{ method: string; url: string }>(
      echoApp(201),
      "/cases?page=1",
      { method: "PUT" },
    );
    expect(status).toBe(201);
    expect(body.method).toBe("PUT");
    expect(body.url).toBe("http://localhost/cases?page=1");
  });
});

describe("testJsonError", () => {
  test("validates the standard error envelope", async () => {
    const app: HandleLike = {
      handle: () => Response.json({
        ok: false,
        code: "FORBIDDEN",
        message: "Forbidden",
      }, { status: 403 }),
    };
    const body = await testJsonError(app, "/cases", {
      status: 403,
      code: "FORBIDDEN",
    });
    expect(body.message).toBe("Forbidden");
  });

  test("rejects mismatched status or code", async () => {
    const app: HandleLike = {
      handle: () => Response.json({
        ok: false,
        code: "NOT_FOUND",
        message: "Not Found",
      }, { status: 404 }),
    };
    expect(testJsonError(app, "/cases", {
      status: 403,
      code: "FORBIDDEN",
    })).rejects.toThrow("Expected status 403");
  });
});
