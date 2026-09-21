import { expect, test } from "bun:test";
import {
  loadServiceControlState, parseServiceControlState, parseServiceOperationReceipt, runServiceOperation,
  type ServiceOperation,
} from "./project-services";
import { serviceControlFixture } from "./project-services.test-fixtures";

test("service states retain real statuses and target units without inventing missing services", () => {
  const fixture = serviceControlFixture();
  const state = parseServiceControlState(fixture, "a");
  expect(state.services).toHaveLength(6);
  expect(state.services.find(row => row.id === "storage")?.controlUnit).toBe("supacloud-storage");
  for (const payload of [null, {}, [], { ...fixture, services: [] },
    { ...fixture, project_ref: "b" }, { ...fixture, services: fixture.services.slice(1) },
    { ...fixture, services: fixture.services.map(() => fixture.services[0]) }]) {
    expect(() => parseServiceControlState(payload, "a")).toThrow();
  }
});

test("invalid flags, cross-project hosts and control targets cannot unlock a service", () => {
  const fixture = serviceControlFixture();
  for (const patch of [
    { healthy: false }, { status: "unknown" }, { control_unit: "other-unit" },
    { service_host_ids: ["b-postgresql"] }, { runtime_mode: "shared" },
  ]) {
    const services = fixture.services.map((row, index) => index === 0 ? { ...row, ...patch } : row);
    expect(() => parseServiceControlState({ ...fixture, services }, "a")).toThrow();
  }
});

test("shared and external auth cannot silently become locally controllable", () => {
  for (const mode of ["local", "owner", "shared", "external"] as const) {
    const fixture = serviceControlFixture("a", mode);
    const state = parseServiceControlState(fixture, "a");
    const auth = state.services.find(row => row.id === "gotrue");
    expect(auth?.runtimeMode).toBe(mode);
    expect(auth?.controllable).toBe(mode === "local" || mode === "owner");
    for (const patch of [{ runtime_mode: undefined }, { local_runtime_enabled: undefined },
      { managed_by_ref: "another-owner" }, { unit: "supacloud-gotrue@wrong" }]) {
      expect(() => parseServiceControlState({
        ...fixture, services: fixture.services.map(row => row.id === "gotrue" ? { ...row, ...patch } : row),
      }, "a")).toThrow();
    }
  }
});

test("operation receipts require explicit success and matching project, action and service", () => {
  const operation: ServiceOperation = { kind: "service", service: "storage", action: "restart" };
  const receipt = { project_ref: "a", service: "storage", action: "restart", success: true };
  expect(() => parseServiceOperationReceipt(receipt, "a", operation)).not.toThrow();
  for (const payload of [null, {}, { ...receipt, success: false }, { ...receipt, project_ref: "b" },
    { ...receipt, service: "gotrue" }, { ...receipt, action: "stop" }]) {
    expect(() => parseServiceOperationReceipt(payload, "a", operation)).toThrow();
  }
  expect(() => parseServiceOperationReceipt({ ref: "a", status: "INACTIVE" }, "a", { kind: "project", action: "pause" })).not.toThrow();
  expect(() => parseServiceOperationReceipt({ ref: "a", status: "ACTIVE_HEALTHY" }, "a", { kind: "project", action: "restore" })).not.toThrow();
  expect(() => parseServiceOperationReceipt({ ref: "a", status: "ACTIVE_HEALTHY" }, "a", { kind: "project", action: "pause" })).toThrow();
  expect(() => parseServiceOperationReceipt({ ref: "a" }, "a", { kind: "project", action: "restart" })).toThrow();
});

test("unsupported control and invalid project state never start transport", async () => {
  let calls = 0;
  const request = async () => { calls++; return Response.json({}); };
  const signal = new AbortController().signal;
  expect(() => loadServiceControlState("../a", request, signal)).toThrow();
  for (const mode of ["shared", "external"] as const) {
    const state = parseServiceControlState(serviceControlFixture("a", mode), "a");
    await expect(runServiceOperation(state, { kind: "service", service: "gotrue", action: "start" }, request, signal)).rejects.toThrow();
  }
  const owner = parseServiceControlState(serviceControlFixture("a", "owner"), "a");
  await expect(runServiceOperation(owner, { kind: "project", action: "pause" }, request, signal)).rejects.toThrow();
  expect(calls).toBe(0);
});

test("service reads and mutations are bounded and do not replay unconfirmed operations", async () => {
  const signal = new AbortController().signal;
  await expect(loadServiceControlState("a", async () => new Response("{}", {
    headers: { "content-length": String(128 * 1024 + 1) },
  }), signal)).rejects.toThrow("Invalid JSON response");
  const state = parseServiceControlState(serviceControlFixture(), "a");
  const calls: Array<{ url: string; method: string | undefined }> = [];
  await expect(runServiceOperation(state, { kind: "service", service: "storage", action: "stop" }, async (url, options) => {
    calls.push({ url, method: options.method });
    return Response.json({ success: true, project_ref: "wrong", service: "storage", action: "stop" });
  }, signal)).rejects.toThrow();
  expect(calls).toEqual([{ url: "/v1/projects/a/services/storage/stop", method: "POST" }]);
});
