import { expect, test } from "bun:test";
import { InvalidPostgrestDesiredStateError, parsePostgrestDesiredState } from "../../src/services/tenant-runtime-desired-state";

test("explicit desired state is authoritative and only missing legacy values use valid project status", () => {
  for (const status of ["active", "creating", "paused", "deleted"]) {
    expect(parsePostgrestDesiredState({ status, postgrest_desired: "running" })).toBe("running");
    expect(parsePostgrestDesiredState({ status, postgrest_desired: "stopped" })).toBe("stopped");
    for (const project of [{ status }, { status, postgrest_desired: undefined }, { status, postgrest_desired: null }]) {
      expect(parsePostgrestDesiredState(project)).toBe(status === "active" ? "running" : "stopped");
    }
  }
  expect(parsePostgrestDesiredState({ postgrest_desired: "running" })).toBe("running");
  const plain: unknown = Object.assign(Object.create(null), { status: "paused" });
  expect(parsePostgrestDesiredState(plain)).toBe("stopped");
});

test("invalid desired values never fall back to active or stopped", () => {
  for (const postgrest_desired of ["", "RUNNING", " running", "stopped ", "unknown", 0, false, {}, [], NaN]) {
    for (const status of ["active", "paused"]) {
      expect(() => parsePostgrestDesiredState({ status, postgrest_desired }))
        .toThrow(InvalidPostgrestDesiredStateError);
    }
  }
  for (const status of [undefined, null, "", "ACTIVE", " active", "unknown", 1, true, [], {}]) {
    expect(() => parsePostgrestDesiredState({ status })).toThrow(InvalidPostgrestDesiredStateError);
  }
  for (const project of [null, undefined, [], new Date(), 1, "active", Object.create({ status: "active" })]) {
    expect(() => parsePostgrestDesiredState(project)).toThrow(InvalidPostgrestDesiredStateError);
  }
});

test("does not execute accessors or coerce status and sanitizes reflection failures", () => {
  let reads = 0;
  const getter = () => { reads++; return "active"; };
  const status = { toString() { reads++; return "active"; } };
  const projects: unknown[] = [
    { status },
    Object.defineProperty({}, "status", { get: getter }),
    Object.defineProperty({ status: "active" }, "postgrest_desired", { get: getter }),
    new Proxy({}, { getPrototypeOf() { throw new Error("private fixture context"); } }),
  ];
  for (const project of projects) {
    expect(() => parsePostgrestDesiredState(project)).toThrow("Invalid persisted PostgREST desired state");
  }
  expect(reads).toBe(0);
});
