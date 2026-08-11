import { describe, expect, test } from "bun:test";
import {
  assertCanonicalPositiveFunctionVersion,
  resolveFunctionVersionBinding,
  resolveTrustedBackgroundFunctionVersionBinding,
} from "./function-version";

describe("active function version validation", () => {
  test("accepts absent and canonical positive safe integer versions", () => {
    for (const version of [null, undefined, "1", "12", String(Number.MAX_SAFE_INTEGER)]) {
      expect(() => assertCanonicalPositiveFunctionVersion(version)).not.toThrow();
    }
  });

  test("rejects zero, non-canonical, unsafe, and overlong versions", () => {
    const invalidVersions = [
      "",
      "0",
      "01",
      "-1",
      "v12",
      "9007199254740992",
      "1".repeat(128),
    ];

    for (const version of invalidVersions) {
      expect(() => assertCanonicalPositiveFunctionVersion(version)).toThrow(
        "Function version must be a canonical positive safe integer",
      );
    }
  });

  test("binds legacy and requested versions without treating zero as a target", () => {
    expect(resolveFunctionVersionBinding(undefined, null)).toEqual({
      activeVersion: null,
      responseVersion: null,
    });
    expect(resolveFunctionVersionBinding(undefined, "0")).toEqual({
      activeVersion: "0",
      responseVersion: null,
    });
    expect(resolveFunctionVersionBinding("12", "0")).toEqual({
      activeVersion: "12",
      responseVersion: "12",
    });
    expect(() => resolveFunctionVersionBinding("0", "12")).toThrow(
      "Function version must be a canonical positive safe integer",
    );
    expect(() => resolveFunctionVersionBinding(undefined, "01")).toThrow(
      "Function version must be a canonical positive safe integer",
    );
  });

  test("keeps a queued legacy-zero background task bound after active version changes", () => {
    expect(resolveTrustedBackgroundFunctionVersionBinding("0", "12")).toEqual({
      activeVersion: "0",
      responseVersion: null,
    });
    expect(resolveTrustedBackgroundFunctionVersionBinding("11", "12")).toEqual({
      activeVersion: "11",
      responseVersion: "11",
    });
    expect(() => resolveTrustedBackgroundFunctionVersionBinding("01", "12")).toThrow(
      "Function version must be a canonical positive safe integer",
    );
  });
});
