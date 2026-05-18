import { afterEach, describe, expect, test } from "bun:test";
import { apiClient } from "./api";

const originalFetch = globalThis.fetch;

describe("apiClient", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("normalizes empty error responses to JSON", async () => {
    globalThis.fetch = async () => new Response("", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "Content-Type": "text/plain" },
    });

    const response = await apiClient("/v1/projects");

    expect(response.status).toBe(502);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({
      message: "Bad Gateway",
      code: "502",
    });
  });
});
