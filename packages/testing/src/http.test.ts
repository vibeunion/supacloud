import { describe, expect, test } from "bun:test";
import { testJson, testRequest } from "./http";
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
