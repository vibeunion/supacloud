import { describe, expect, test } from "bun:test";
import { requiresProcessIsolation } from "./run-unit-tests";

describe("unit test process isolation classifier", () => {
  test("isolates tests that opt into the process marker", () => {
    expect(requiresProcessIsolation("// @supacloud-test-isolate\nimport { spawnSync } from 'node:child_process';")).toBe(true);
    expect(requiresProcessIsolation("describe('pure test', () => {});\n")).toBe(false);
  });

  test("isolates tests that spy on Bun process globals", () => {
    expect(requiresProcessIsolation('spyOn(Bun, "spawn").mockImplementation(() => ({}));')).toBe(true);
    expect(requiresProcessIsolation('spyOn(service, "run").mockImplementation(() => ({}));')).toBe(false);
  });
});
