import { expect, test } from "bun:test";
import { checkRpcBoundary } from "./rpc-boundary";

test("accepts registry and generated catalog names, including schema-qualified functions", () => {
  const report = checkRpcBoundary({
    capabilities: ["approveCase", "public.create_case", "legacy_case"],
    registry: [{ name: "approveCase" }],
    catalog: { definitions: [{ name: "public.create_case" }] },
    legacy: { legacyRpcNames: ["legacy_case"] },
  });
  expect(report.ok).toBe(true);
  expect(report.sourced).toEqual(["approveCase", "public.create_case"]);
  expect(report.historical).toEqual(["legacy_case"]);
  expect(report.missing).toEqual([]);
});

test("fails closed when a capability has no registry, catalog or historical source", () => {
  const report = checkRpcBoundary({
    capabilities: ["approveCase", "unownedCase"],
    registry: ["approveCase"],
  });
  expect(report.ok).toBe(false);
  expect(report.missing).toEqual(["unownedCase"]);
});

test("rejects malformed artifact shapes and capability names", () => {
  expect(() => checkRpcBoundary({ capabilities: ["approveCase"], registry: { nope: true } })).toThrow("registry");
  expect(() => checkRpcBoundary({ capabilities: ["bad name"] })).toThrow("capability names");
});
