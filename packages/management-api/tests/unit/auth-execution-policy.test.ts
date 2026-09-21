import { describe, expect, test } from "bun:test";
import {
  resolveAuthExecutionPolicy,
  type AuthExecutionPolicy,
} from "../../src/services/auth-execution-policy";
import { GotrueRuntimeController } from "../../src/services/tenant-runtime.service";

const localAuthority = { mode: "local", authority_project_ref: "project-a" } as const;
const externalConfig = {
  auth: { third_party_auth: { enabled: true, auth_upstream: "127.0.0.1:3367" } },
};
const localPolicy = resolveAuthExecutionPolicy(localAuthority, {});
const externalPolicy = resolveAuthExecutionPolicy(localAuthority, externalConfig);

describe("Auth execution policy", () => {
  test("keeps absent legacy configuration and explicitly disabled third-party Auth local", () => {
    for (const config of [undefined, null, "", {}, "{}", { auth: {} }, {
      auth: { third_party_auth: { enabled: false, auth_endpoint_mode: "external" } },
    }, { auth: { third_party_auth: { enabled: true, auth_endpoint_mode: "local" } } }]) {
      expect(resolveAuthExecutionPolicy(localAuthority, config)).toEqual(localPolicy);
    }
  });

  test("accepts serialized configuration and documented aliases without inferring local execution", () => {
    expect(externalPolicy).toEqual({ mode: "external", localGoTrue: false, upstream: "127.0.0.1:3367" });
    expect(resolveAuthExecutionPolicy(localAuthority, JSON.stringify(externalConfig))).toEqual(externalPolicy);
    expect(resolveAuthExecutionPolicy(localAuthority, {
      auth: { third_party_auth: { enabled: true, authEndpointMode: "external", authUpstream: "127.0.0.1:3367" } },
    })).toEqual(externalPolicy);
  });

  test("never silently downgrades malformed configuration to local execution", () => {
    for (const config of ["not-json", "null", "[]", [], 1, false, { auth: null },
      { auth: [] }, { auth: { third_party_auth: "external" } }]) {
      expect(() => resolveAuthExecutionPolicy(localAuthority, config)).toThrow();
    }
    for (const thirdParty of [
      { enabled: "true" }, { enabled: null }, { enabled: true },
      { enabled: true, auth_endpoint_mode: "typo", auth_upstream: "host:1234" },
      { enabled: true, auth_endpoint_mode: "external", authEndpointMode: "local", auth_upstream: "host:1234" },
      { enabled: true, auth_upstream: "host:1234", authUpstream: "other:1234" },
      { enabled: true, auth_upstream: 1234 },
      { enabled: true, auth_upstream: "" },
      { enabled: true, auth_upstream: "host:1234\n" },
    ]) {
      expect(() => resolveAuthExecutionPolicy(localAuthority, {
        auth: { third_party_auth: thirdParty },
      })).toThrow();
    }
  });

  test("keeps platform ownership authoritative even over conflicting project configuration", () => {
    for (const config of [externalConfig, "invalid-child-config"]) {
      expect(resolveAuthExecutionPolicy({ mode: "shared", authority_project_ref: "owner" }, config))
        .toEqual({ mode: "shared", localGoTrue: false, authorityRef: "owner" });
      expect(resolveAuthExecutionPolicy({ mode: "owner", authority_project_ref: "owner" }, config))
        .toEqual({ mode: "owner", localGoTrue: true, authorityRef: "owner" });
    }
  });
});

describe("GoTrue activating command boundary", () => {
  test("blocks every activating command for shared and external policies", async () => {
    const policies: AuthExecutionPolicy[] = [
      externalPolicy, { mode: "shared", localGoTrue: false, authorityRef: "owner" },
    ];
    for (const policy of policies) {
      const commands: string[] = [];
      const controller = new GotrueRuntimeController(async () => policy, async (action, unit) => {
        commands.push(`${action} ${unit}`);
      });
      for (const action of ["enable", "start", "restart"] as const) {
        await expect(controller[action]("project-a")).rejects.toThrow("Local GoTrue control is disabled");
      }
      expect(commands).toEqual([]);
    }
  });

  test("re-reads the policy for the same ref before each command", async () => {
    const commands: string[] = [];
    const reads: string[] = [];
    let policy = localPolicy;
    const controller = new GotrueRuntimeController(async ref => {
      reads.push(ref);
      return policy;
    }, async (action, unit) => { commands.push(`${action} ${unit}`); });
    await controller.enable("project-a");
    policy = externalPolicy;
    await expect(controller.start("project-a")).rejects.toThrow("external Auth");
    policy = localPolicy;
    await controller.restart("project-a");
    expect(reads).toEqual(["project-a", "project-a", "project-a"]);
    expect(commands).toEqual(["enable supacloud-gotrue@project-a", "restart supacloud-gotrue@project-a"]);
  });

  test("propagates policy-read and command failures without reporting successful activation", async () => {
    let executions = 0;
    const unavailable = new GotrueRuntimeController(async () => {
      throw new Error("metadata unavailable");
    }, async () => { executions++; });
    await expect(unavailable.start("project-a")).rejects.toThrow("metadata unavailable");
    expect(executions).toBe(0);
    const denied = new GotrueRuntimeController(async () => localPolicy, async () => {
      throw new Error("systemctl denied");
    });
    await expect(denied.restart("project-a")).rejects.toThrow("systemctl denied");
  });
});
