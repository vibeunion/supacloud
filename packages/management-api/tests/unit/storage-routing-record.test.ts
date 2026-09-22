import { describe, expect, test } from "bun:test";
import {
  assertStorageRoutingRef, parseStorageRoutingRows, StorageRoutingUnavailableError,
} from "../../src/utils/storage-routing-record";

function row(overrides: Record<string, unknown> = {}) {
  return { ref: "project_a", status: "active", deleted_at: null, config: {}, ...overrides };
}

describe("storage routing records", () => {
  test("preserves native, nullable, legacy JSON and legacy domain configurations", () => {
    const config = {
      api_domain: "api.example.com",
      custom_domain: null,
      additional_api_domains: ["another.example.com"],
      api_domains: "legacy.example.com",
      unrelated_setting: { value: 42 },
    };
    expect(parseStorageRoutingRows([row({ config })], "project_a"))
      .toEqual([{ ref: "project_a", config }]);
    expect(parseStorageRoutingRows([row({ config: null, status: "CREATING" })]))
      .toEqual([{ ref: "project_a", config: {} }]);
    expect(parseStorageRoutingRows([row({ config: JSON.stringify(config), status: "ACTIVE" })]))
      .toEqual([{ ref: "project_a", config }]);
    for (const domain of ["api.example.com", "localhost:8080", "127.0.0.1:8000", "[::1]:8000"]) {
      expect(parseStorageRoutingRows([row({ config: domain })]))
        .toEqual([{ ref: "project_a", config: { custom_domain: domain } }]);
    }
    expect(parseStorageRoutingRows([])).toEqual([]);
  });

  test.each([
    null, undefined, {}, "[]", [null], [[]], [42], Array(1),
    [row({ ref: 42 })], [row({ ref: "" })], [row({ ref: "project.a" })],
    [row({ ref: undefined })], [row({ status: undefined })],
    [row({ status: "paused" })], [row({ status: " active " })],
    [row({ deleted_at: new Date() })], [row({ deleted_at: undefined })],
    [row({ config: undefined })], [row({ config: [] })], [row({ config: true })],
    [row({ config: "[]" })], [row({ config: "null" })], [row({ config: "42" })],
    [row({ config: '"api.example.com"' })], [row({ config: "{bad json" })],
    [row({ config: "https://api.example.com" })], [row({ config: "user@api.example.com" })],
    [row({ config: "api.example.com/path" })], [row({ config: "api.example.com\n.attacker.test" })],
    [row({ config: { api_domain: 42 } })], [row({ config: { custom_domain: true } })],
    [row({ config: { api_domain: undefined } })],
    [row({ config: { additional_api_domains: [42] } })],
    [row({ config: { api_domains: {} } })],
    [row(), row()],
  ].map((value): { value: unknown } => ({ value })))("rejects malformed routing records %#", ({ value }) => {
    expect(() => parseStorageRoutingRows(value)).toThrow(StorageRoutingUnavailableError);
  });

  test("rejects cross-project receipts and oversized serialized configurations", () => {
    expect(() => parseStorageRoutingRows([row()], "project_b")).toThrow(StorageRoutingUnavailableError);
    expect(() => parseStorageRoutingRows([row({ config: `{"unused":"${"x".repeat(1024 * 1024)}"}` })]))
      .toThrow(StorageRoutingUnavailableError);
  });

  test("validates project references without coercion", () => {
    for (const ref of ["project_a", "project-b", "Project123"]) {
      expect(() => assertStorageRoutingRef(ref)).not.toThrow();
    }
    for (const ref of ["", "project'a", "project.a", " leading", 42, null, undefined]) {
      expect(() => assertStorageRoutingRef(ref)).toThrow(StorageRoutingUnavailableError);
    }
  });
});
