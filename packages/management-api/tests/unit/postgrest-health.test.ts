import { describe, expect, test } from "bun:test";
import { probePostgrestHealth } from "../../src/services/tenant-runtime.service";

function response(status: number): Response {
  return new Response(null, { status });
}

describe("PostgREST health probe", () => {
  test("accepts /live even when the root path would be unavailable", async () => {
    const seen: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      return response(url.endsWith("/live") ? 200 : 404);
    };

    const result = await probePostgrestHealth(3101, fetcher as typeof fetch);

    expect(result).toEqual({ healthy: true, last_error: null });
    expect(seen).toEqual(["http://127.0.0.1:3101/live"]);
  });

  test("treats client errors as reachable runtime responses", async () => {
    const seen: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      return response(404);
    };

    const result = await probePostgrestHealth(3101, fetcher as typeof fetch);

    expect(result).toEqual({ healthy: true, last_error: null });
    expect(seen).toEqual(["http://127.0.0.1:3101/live"]);
  });

  test("falls back to legacy root probing after /live and /ready fail", async () => {
    const seen: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      return response(url.endsWith("/") ? 200 : 503);
    };

    const result = await probePostgrestHealth(3101, fetcher as typeof fetch);

    expect(result).toEqual({ healthy: true, last_error: null });
    expect(seen).toEqual([
      "http://127.0.0.1:3101/live",
      "http://127.0.0.1:3101/ready",
      "http://127.0.0.1:3101/",
    ]);
  });

  test("reports all failed health endpoints", async () => {
    const fetcher = async () => response(503);

    const result = await probePostgrestHealth(3101, fetcher as typeof fetch);

    expect(result.healthy).toBe(false);
    expect(result.last_error).toContain("/live HTTP 503");
    expect(result.last_error).toContain("/ready HTTP 503");
    expect(result.last_error).toContain("/ HTTP 503");
  });
});
