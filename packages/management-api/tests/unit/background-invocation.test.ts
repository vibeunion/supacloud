import { describe, expect, test } from "bun:test";
import {
  InvalidBackgroundInvocationError,
  parseBackgroundInvocation,
} from "../../src/utils/background-invocation";

const validInvocation = {
  method: "POST" as const,
  path: "/generate",
  query: "?mode=fast",
  headers: { "content-type": "application/json" },
  body: "{\"input\":true}",
  body_encoding: "utf8" as const,
  requested_timeout_sec: 300,
  auth: { kind: "jwt" as const, invoker_role: "authenticated" },
};

describe("background invocation envelope", () => {
  test("normalizes omitted fields and captures plain data", () => {
    expect(parseBackgroundInvocation({ auth: { kind: "none" } })).toEqual({
      method: "POST",
      path: "",
      query: "",
      headers: {},
      body: null,
      body_encoding: "utf8",
      auth: { kind: "none" },
    });
  });

  test("accepts a valid request envelope", () => {
    expect(parseBackgroundInvocation(validInvocation)).toEqual(validInvocation);
  });

  test("rejects unsafe paths, queries, headers, and methods", () => {
    for (const value of [
      { ...validInvocation, path: "relative" },
      { ...validInvocation, path: "/generate?bad" },
      { ...validInvocation, query: "mode=fast" },
      { ...validInvocation, method: "GET", body: "unexpected" },
      { ...validInvocation, headers: { "x-test": "line\nfeed" } },
      { ...validInvocation, headers: { "X-Test": "one", "x-test": "two" } },
    ]) {
      expect(() => parseBackgroundInvocation(value)).toThrow(InvalidBackgroundInvocationError);
    }
  });

  test("rejects accessors, inherited records, and cycles without executing getters", () => {
    let getterReads = 0;
    const withGetter = { ...validInvocation };
    Object.defineProperty(withGetter, "body", {
      enumerable: true,
      get: () => {
        getterReads++;
        throw new Error("getter must not execute");
      },
    });
    const inherited = Object.assign(Object.create({ method: "POST" }), {
      ...validInvocation,
      method: undefined,
    });
    const cyclic: Record<string, unknown> = { ...validInvocation };
    cyclic.body = cyclic;

    for (const value of [withGetter, inherited, cyclic]) {
      expect(() => parseBackgroundInvocation(value)).toThrow(InvalidBackgroundInvocationError);
    }
    expect(getterReads).toBe(0);
  });
});
