import { expect, test } from "bun:test";
import {
  assertPlatformDeploymentTransition,
  derivePlatformDeploymentStatus,
  parsePlatformDeploymentState,
  platformDeploymentRetryAction,
  SINGLE_NODE_REQUIRED_COMPONENTS,
  type PlatformDeploymentState,
} from "./platform-deployment";

const checkedAt = "2026-11-10T00:00:00.000Z";
const manifest = "a".repeat(64);
const release = "single-node-20261110";

function state(overrides: Partial<PlatformDeploymentState> = {}): PlatformDeploymentState {
  const components: PlatformDeploymentState["actual"]["components"] = SINGLE_NODE_REQUIRED_COMPONENTS.map(name => ({
    name,
    version: "1.0.0",
    status: "ready",
    health_check: "/health",
    checked_at: checkedAt,
  }));
  const base: PlatformDeploymentState = {
    schema: "supacloud.platform-deployment-state.v1",
    profile: "single-node",
    host: { os: "linux", distribution: "ubuntu", version: "24.04", architecture: "amd64", init: "systemd" },
    desired: { state: "running", release_id: release, manifest_sha256: manifest },
    actual: {
      state: "running", release_id: release, manifest_sha256: manifest, checked_at: checkedAt,
      components,
    },
    operation: { mutation_id: "install-20261110", phase: "confirmed", retry: "none", error: null },
    rollback: { release_id: "single-node-20261109", ready: true },
  };
  return { ...base, ...overrides };
}

test("confirms a running single-node deployment only when observed release and components match", () => {
  const value = state();
  expect(derivePlatformDeploymentStatus(value)).toBe("confirmed");
  expect(parsePlatformDeploymentState(value)).toEqual(value);
});

test("unknown observations require reconciliation of the same mutation", () => {
  const value = state({
    actual: { ...state().actual, state: "unknown", checked_at: checkedAt },
    operation: {
      mutation_id: "install-20261110", phase: "unknown", retry: "reconcile-same-mutation", error: "lost response",
    },
  });
  expect(derivePlatformDeploymentStatus(value)).toBe("unknown");
  expect(platformDeploymentRetryAction("unknown")).toBe("reconcile-same-mutation");
  expect(parsePlatformDeploymentState(value)).toEqual(value);
});

test("rejects a running desired state without an immutable release binding", () => {
  expect(() => parsePlatformDeploymentState(state({
    desired: { state: "running", release_id: null, manifest_sha256: null },
  }))).toThrow("Invalid platform deployment state.");
});

test("rejects duplicate components and an unbound mutation phase", () => {
  const value = state({
    actual: {
      ...state().actual,
      components: [state().actual.components[0]!, state().actual.components[0]!],
    },
  });
  expect(() => parsePlatformDeploymentState(value)).toThrow("Invalid platform deployment state.");

  expect(() => parsePlatformDeploymentState(state({
    operation: { mutation_id: null, phase: "activating", retry: "reconcile-same-mutation", error: null },
  }))).toThrow("Invalid platform deployment state.");
});

test("keeps terminal operation transitions explicit", () => {
  expect(() => assertPlatformDeploymentTransition("unknown", "confirmed")).not.toThrow();
  expect(() => assertPlatformDeploymentTransition("confirmed", "activating")).toThrow("Invalid platform deployment transition");
  expect(() => assertPlatformDeploymentTransition("failed", "preparing")).not.toThrow();
});

test("does not confirm a stopped deployment until every required component is stopped", () => {
  const value = state({
    desired: { state: "stopped", release_id: null, manifest_sha256: null },
    actual: {
      ...state().actual,
      state: "stopped",
      components: state().actual.components.map((component, index) => ({
        ...component,
        status: index === 0 ? "ready" : "stopped",
      })),
    },
    operation: { mutation_id: "stop-20261110", phase: "preparing", retry: "reconcile-same-mutation", error: null },
  });
  expect(derivePlatformDeploymentStatus(value)).toBe("incomplete");
  expect(parsePlatformDeploymentState(value)).toEqual(value);
});
