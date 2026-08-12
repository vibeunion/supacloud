import { describe, expect, test } from "bun:test";
import {
  parsePostgrestActivity,
  probePostgrestHealth,
} from "../../src/services/tenant-runtime.service";

function response(status: number): Response {
  return new Response(null, { status });
}

describe("PostgREST health probe", () => {
  test("probes the PostgREST root endpoint", async () => {
    const seen: string[] = [];
    const fetcher = async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      return response(200);
    };

    const result = await probePostgrestHealth(3101, fetcher as typeof fetch);

    expect(result).toEqual({ healthy: true, last_error: null });
    expect(seen).toEqual(["http://127.0.0.1:3101/"]);
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
    expect(seen).toEqual(["http://127.0.0.1:3101/"]);
  });

  test("reports a failed root endpoint", async () => {
    const fetcher = async () => response(503);

    const result = await probePostgrestHealth(3101, fetcher as typeof fetch);

    expect(result.healthy).toBe(false);
    expect(result.last_error).toBe("PostgREST health checks failed: / HTTP 503");
  });
});

describe("PostgREST systemd activity parser", () => {
  test("accepts only systemctl's canonical active and inactive results", () => {
    expect(parsePostgrestActivity("active\n", 0)).toBe(true);
    expect(parsePostgrestActivity("inactive\n", 3)).toBe(false);
    expect(parsePostgrestActivity("failed\n", 3)).toBe(false);
  });

  test("rejects empty, unknown, and contradictory exit-state pairs", () => {
    const contradictions: Array<[string, number]> = [
      ["", 0],
      ["unknown\n", 4],
      ["active\n", 3],
      ["inactive\n", 0],
      ["failed\n", 0],
      ["activating\n", 0],
      ["active\nextra\n", 0],
    ];

    for (const [output, exitCode] of contradictions) {
      expect(() => parsePostgrestActivity(output, exitCode))
        .toThrow("Unable to determine PostgREST systemd activity");
    }
  });
});
