import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { config } from "../../src/config";
import { runtimeEnvService } from "../../src/services/runtime-env.service";
import {
  buildPublicRuntimeSnapshot,
  runtimeSnapshotServiceInternals,
} from "../../src/services/runtime-snapshot.service";
import { tenantRuntimeService } from "../../src/services/tenant-runtime.service";
import {
  edgeRuntimeEnvProof,
  postgrestConfigRevision,
  runtimeEnvRevision,
} from "../../src/services/runtime-revision";
import { parseProjectRuntimeSnapshot } from "../../../admin/src/shared/tools/project-runtime-snapshot";

const PROJECT_REF = "afemibrarjkvzuuawjfi";
const REVISION = `hmac-sha256:${"a".repeat(64)}`;
const PROOF = `hmac-sha256:${"b".repeat(64)}`;
const LOADED_AT = "2026-08-11T00:00:00.000Z";
const originalFetch = globalThis.fetch;
const originalEdgeRuntimeMasterKey = config.edgeRuntimeMasterKey;
type RedirectCapture = { requests: number; credential: string | null };

afterEach(() => {
  globalThis.fetch = originalFetch;
  config.edgeRuntimeMasterKey = originalEdgeRuntimeMasterKey;
  mock.restore();
});

function observation(overrides: Record<string, unknown> = {}) {
  return {
    schema: "supacloud.edge-runtime-env-observation.v1",
    project_ref: PROJECT_REF,
    loaded_revision: REVISION,
    env_proof: PROOF,
    load_state: "loaded",
    load_source: "management_api",
    loaded_at: LOADED_AT,
    ...overrides,
  };
}

function postgrestSnapshot(desiredRevision: string) {
  return {
    desiredRevision,
    loadedRevision: desiredRevision,
    attestationState: "loaded" as const,
    matchesDesired: true,
    actual: "running" as const,
    health: "healthy" as const,
    loadedAt: LOADED_AT,
    desired: "running" as const,
    port: 3101,
    unit: `supacloud-pgrst@${PROJECT_REF}`,
  };
}

function redirectedObservationTarget(capture: RedirectCapture): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      capture.requests += 1;
      capture.credential = request.headers.get("x-supacloud-internal-auth");
      return Response.json(observation());
    },
  });
}

function observationRedirectSource(
  status: 302 | 307,
  location: string,
  capture?: RedirectCapture,
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (capture && new URL(request.url).pathname === "/redirect-target") {
        capture.requests += 1;
        capture.credential = request.headers.get("x-supacloud-internal-auth");
        return Response.json(observation());
      }
      return new Response(null, { status, headers: { location } });
    },
  });
}

async function expectObservationRedirectRejected(
  status: 302 | 307,
  scope: "same-origin" | "cross-origin",
): Promise<void> {
  const capture: RedirectCapture = { requests: 0, credential: null };
  const target = scope === "cross-origin" ? redirectedObservationTarget(capture) : null;
  const location = target ? `http://127.0.0.1:${target.port}/redirect-target` : "/redirect-target";
  const source = observationRedirectSource(status, location, target ? undefined : capture);
  const previousEdgeRuntimeInternal = config.edgeRuntimeInternal;
  config.edgeRuntimeInternal = `127.0.0.1:${source.port}`;
  try {
    expect(await runtimeSnapshotServiceInternals.fetchRuntimeEnvObservation(PROJECT_REF))
      .toBeNull();
    expect(capture.requests).toBe(0);
    expect(capture.credential).toBeNull();
  } finally {
    config.edgeRuntimeInternal = previousEdgeRuntimeInternal;
    source.stop(true);
    target?.stop(true);
  }
}

describe("runtime environment observation validation", () => {
  test("accepts each canonical observation state", () => {
    expect(runtimeSnapshotServiceInternals.runtimeEnvObservation(
      observation(),
      PROJECT_REF,
    )).not.toBeNull();
    expect(runtimeSnapshotServiceInternals.runtimeEnvObservation(
      observation({
        loaded_revision: null,
        env_proof: null,
        load_state: "unverified",
        load_source: "file_fallback",
      }),
      PROJECT_REF,
    )).not.toBeNull();
    expect(runtimeSnapshotServiceInternals.runtimeEnvObservation(
      observation({
        loaded_revision: null,
        env_proof: null,
        load_state: "not_loaded",
        load_source: null,
        loaded_at: null,
      }),
      PROJECT_REF,
    )).not.toBeNull();
  });

  test("rejects extra keys, cross-project payloads, and impossible state combinations", () => {
    const invalidPayloads = [
      observation({ extra: true }),
      observation({ project_ref: "other-project" }),
      observation({ load_state: "loaded", loaded_at: null }),
      observation({ load_state: "loaded", load_source: "stale_cache" }),
      observation({ load_state: "unverified" }),
      observation({ load_state: "not_loaded", load_source: "file_fallback" }),
      observation({ loaded_revision: "sha256:not-attested" }),
      observation({ loaded_at: "2026-08-11 00:00:00" }),
    ];

    for (const payload of invalidPayloads) {
      expect(runtimeSnapshotServiceInternals.runtimeEnvObservation(payload, PROJECT_REF))
        .toBeNull();
    }
  });

  test("treats oversized, malformed UTF-8, and failed observations as unavailable", async () => {
    const oversized = new Uint8Array(64 * 1024 + 1);
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    const fetchers = [
      async () => new Response(oversized, { status: 200 }),
      async () => new Response(invalidUtf8, { status: 200 }),
      async () => {
        throw new Error("edge unavailable");
      },
    ];

    for (const fetcher of fetchers) {
      expect(await runtimeSnapshotServiceInternals.fetchRuntimeEnvObservation(
        PROJECT_REF,
        fetcher as typeof fetch,
      )).toBeNull();
    }
  });

  test.each([302, 307])(
    "refuses same-origin HTTP %i redirects before forwarding internal credentials",
    async (status) => {
      config.edgeRuntimeMasterKey = "runtime-snapshot-redirect-key";
      await expectObservationRedirectRejected(status, "same-origin");
    },
  );

  test.each([302, 307])(
    "refuses cross-origin HTTP %i redirects before forwarding internal credentials",
    async (status) => {
      config.edgeRuntimeMasterKey = "runtime-snapshot-redirect-key";
      await expectObservationRedirectRejected(status, "cross-origin");
    },
  );
});

describe("public runtime snapshot", () => {
  test("returns the exact public schema without the private environment proof", async () => {
    config.edgeRuntimeMasterKey = "runtime-snapshot-test-key";
    const runtimeEnv = { FEATURE_SETTING: "enabled" };
    const desiredEnvRevision = runtimeEnvRevision(PROJECT_REF, runtimeEnv);
    const desiredEnvProof = edgeRuntimeEnvProof(PROJECT_REF, runtimeEnv);
    const desiredPostgrestRevision = postgrestConfigRevision(PROJECT_REF, "db-pool = 10\n");
    spyOn(runtimeEnvService, "buildProjectRuntimeEnv").mockResolvedValue(runtimeEnv);
    spyOn(tenantRuntimeService, "runtimeSnapshotPostgrest")
      .mockResolvedValue(postgrestSnapshot(desiredPostgrestRevision));
    globalThis.fetch = mock(async () => Response.json(observation({
      loaded_revision: desiredEnvRevision,
      env_proof: desiredEnvProof,
    }))) as typeof fetch;

    const snapshot = await buildPublicRuntimeSnapshot(PROJECT_REF);

    expect(Object.keys(snapshot).sort()).toEqual([
      "captured_at",
      "postgrest",
      "project_ref",
      "schema",
      "secrets",
    ]);
    expect(Object.keys(snapshot.secrets).sort()).toEqual([
      "desired_revision",
      "load_source",
      "load_state",
      "loaded_at",
      "loaded_revision",
      "matches_desired",
    ]);
    expect(Object.keys(snapshot.postgrest).sort()).toEqual([
      "actual",
      "attestation_state",
      "desired",
      "desired_revision",
      "health",
      "loaded_at",
      "loaded_revision",
      "matches_desired",
      "port",
      "unit",
    ]);
    expect(snapshot).toMatchObject({
      schema: "supacloud.runtime-snapshot.v1",
      project_ref: PROJECT_REF,
      secrets: {
        desired_revision: desiredEnvRevision,
        loaded_revision: desiredEnvRevision,
        load_state: "current",
        load_source: "management_api",
        matches_desired: true,
      },
      postgrest: {
        desired_revision: desiredPostgrestRevision,
        loaded_revision: desiredPostgrestRevision,
        attestation_state: "loaded",
        matches_desired: true,
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain(desiredEnvProof);
  });

  test("returns a snapshot when only the Edge observation is unavailable", async () => {
    config.edgeRuntimeMasterKey = "runtime-snapshot-test-key";
    const runtimeEnv = { FEATURE_SETTING: "enabled" };
    const desiredPostgrestRevision = postgrestConfigRevision(PROJECT_REF, "db-pool = 10\n");
    spyOn(runtimeEnvService, "buildProjectRuntimeEnv").mockResolvedValue(runtimeEnv);
    spyOn(tenantRuntimeService, "runtimeSnapshotPostgrest")
      .mockResolvedValue(postgrestSnapshot(desiredPostgrestRevision));
    globalThis.fetch = mock(async () => {
      throw new Error("edge unavailable");
    }) as typeof fetch;

    const snapshot = await buildPublicRuntimeSnapshot(PROJECT_REF);

    expect(snapshot.secrets).toMatchObject({
      desired_revision: runtimeEnvRevision(PROJECT_REF, runtimeEnv),
      loaded_revision: null,
      load_state: "unreachable",
      matches_desired: null,
    });
    expect(snapshot.postgrest.desired_revision).toBe(desiredPostgrestRevision);
  });

  test("projects a different loaded revision as stale and round-trips through the Admin parser", async () => {
    config.edgeRuntimeMasterKey = "runtime-snapshot-test-key";
    const runtimeEnv = { FEATURE_SETTING: "enabled" };
    const desiredEnvProof = edgeRuntimeEnvProof(PROJECT_REF, runtimeEnv);
    const desiredPostgrestRevision = postgrestConfigRevision(PROJECT_REF, "db-pool = 10\n");
    spyOn(runtimeEnvService, "buildProjectRuntimeEnv").mockResolvedValue(runtimeEnv);
    spyOn(tenantRuntimeService, "runtimeSnapshotPostgrest")
      .mockResolvedValue(postgrestSnapshot(desiredPostgrestRevision));
    globalThis.fetch = mock(async () => Response.json(observation({
      loaded_revision: REVISION,
      env_proof: desiredEnvProof,
    }))) as typeof fetch;

    const snapshot = await buildPublicRuntimeSnapshot(PROJECT_REF);

    expect(snapshot.secrets).toMatchObject({
      desired_revision: runtimeEnvRevision(PROJECT_REF, runtimeEnv),
      loaded_revision: REVISION,
      load_state: "stale",
      matches_desired: false,
    });
    expect(parseProjectRuntimeSnapshot(snapshot, PROJECT_REF)).toEqual(snapshot);
  });

  test("fails when authoritative runtime environment input is unavailable", async () => {
    const desiredPostgrestRevision = postgrestConfigRevision(PROJECT_REF, "db-pool = 10\n");
    spyOn(runtimeEnvService, "buildProjectRuntimeEnv").mockResolvedValue(null);
    spyOn(tenantRuntimeService, "runtimeSnapshotPostgrest")
      .mockResolvedValue(postgrestSnapshot(desiredPostgrestRevision));

    await expect(buildPublicRuntimeSnapshot(PROJECT_REF))
      .rejects.toThrow("Authoritative runtime environment is unavailable");
  });
});
