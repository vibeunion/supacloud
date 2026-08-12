import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  FrontendReleaseError,
  FrontendReleaseService,
  type FrontendReleaseActivation,
} from "../../src/services/frontend-release.service";
import type { FrontendReleaseStorage } from "../../src/services/frontend-release-storage";
import type {
  BeginProjectMutationInput,
  BeginProjectMutationResult,
  ClaimProjectMutationInput,
  ClaimProjectMutationResult,
  CompleteProjectMutationFailureInput,
  CompleteProjectMutationSuccessInput,
  ProjectMutationState,
} from "../../src/services/project-mutation.service";

const PROJECT_REF = "abcdefghijklmnopqrst";
const DEPLOYMENT_ID = "fa-web";
const MUTATION_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_MUTATION_ID = "00000000-0000-4000-8000-000000000002";
const THIRD_MUTATION_ID = "00000000-0000-4000-8000-000000000003";
const FIXED_TIME = "2026-08-12T00:00:00.000Z";
const roots = new Set<string>();

interface StoredMutation {
  begin: BeginProjectMutationInput;
  state: ProjectMutationState;
  leaseToken: string | null;
}

function mutationState(
  begin: BeginProjectMutationInput,
  overrides: Partial<ProjectMutationState> = {},
): ProjectMutationState {
  return {
    projectRef: begin.projectRef,
    mutationId: begin.mutationId,
    operation: begin.operation,
    resourceKey: `v1/frontend_release/${Buffer.from(DEPLOYMENT_ID).toString("base64url")}`,
    requestFingerprint: begin.requestFingerprint,
    principal: begin.principal,
    status: "pending",
    checkpoint: {},
    receipt: null,
    responseStatus: null,
    failureCode: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    fencingEpoch: 0,
    completedAt: null,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...overrides,
  };
}

class MemoryMutations {
  readonly mutations = new Map<string, StoredMutation>();
  readonly events: string[] = [];
  rejectNextLease = false;
  leaseDepth = 0;
  corruptNextSuccessJournal?: (state: ProjectMutationState) => ProjectMutationState;

  private async begin(input: BeginProjectMutationInput): Promise<BeginProjectMutationResult> {
    const stored = this.mutations.get(input.mutationId);
    if (stored) {
      if (stored.begin.requestFingerprint !== input.requestFingerprint) return { kind: "fingerprint_conflict" };
      if (JSON.stringify(stored.begin.principal) !== JSON.stringify(input.principal)) return { kind: "principal_conflict" };
      return { kind: "replay", mutation: stored.state };
    }
    const state = mutationState(input);
    this.mutations.set(input.mutationId, { begin: input, state, leaseToken: null });
    return { kind: "started", mutation: state };
  }

  private async claim(input: ClaimProjectMutationInput): Promise<ClaimProjectMutationResult> {
    const stored = this.mutations.get(input.mutationId);
    if (!stored) return { kind: "not_found" };
    if (["succeeded", "failed_terminal", "outcome_unknown"].includes(stored.state.status)) {
      return { kind: "terminal", mutation: stored.state };
    }
    stored.leaseToken = input.leaseToken;
    stored.state = {
      ...stored.state,
      status: "running",
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: "2026-08-12T00:05:00.000Z",
      fencingEpoch: stored.state.fencingEpoch + 1,
      completedAt: null,
    };
    return { kind: "claimed", mutation: stored.state };
  }

  async beginAndClaim(
    begin: BeginProjectMutationInput,
    claim: Omit<ClaimProjectMutationInput, "projectRef" | "mutationId"> & {
      initialCheckpoint?: Record<string, unknown>;
    },
  ): Promise<{ begun: BeginProjectMutationResult; claimed?: ClaimProjectMutationResult }> {
    const begun = await this.begin(begin);
    if (begun.kind !== "started" && begun.kind !== "replay") return { begun };
    if (begun.kind === "replay" && ["succeeded", "failed_terminal", "outcome_unknown"].includes(
      begun.mutation.status,
    )) return { begun };
    const claimed = await this.claim({ projectRef: begin.projectRef, mutationId: begin.mutationId, ...claim });
    if (begun.kind === "started" && claimed.kind === "claimed") {
      if (!claim.initialCheckpoint) throw new Error("initial checkpoint required");
      const stored = this.mutations.get(begin.mutationId)!;
      stored.state = { ...stored.state, checkpoint: claim.initialCheckpoint };
    }
    return {
      begun,
      claimed,
    };
  }

  async checkpoint(input: {
    mutationId: string;
    leaseToken: string;
    fencingEpoch: number;
    checkpoint: Record<string, unknown>;
  }): Promise<"updated" | "lease_lost"> {
    const stored = this.mutations.get(input.mutationId);
    if (!stored || stored.leaseToken !== input.leaseToken
      || stored.state.fencingEpoch !== input.fencingEpoch) return "lease_lost";
    stored.state = { ...stored.state, checkpoint: input.checkpoint };
    return "updated";
  }

  async completeSuccess(input: CompleteProjectMutationSuccessInput): Promise<"updated" | "lease_lost"> {
    const stored = this.mutations.get(input.mutationId);
    if (!stored || stored.leaseToken !== input.leaseToken
      || stored.state.fencingEpoch !== input.fencingEpoch) return "lease_lost";
    const successfulState: ProjectMutationState = {
      ...stored.state,
      status: "succeeded",
      receipt: input.receipt,
      responseStatus: input.responseStatus,
      failureCode: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: FIXED_TIME,
    };
    stored.state = this.corruptNextSuccessJournal?.(successfulState) ?? successfulState;
    this.corruptNextSuccessJournal = undefined;
    stored.leaseToken = null;
    return "updated";
  }

  async completeFailure(input: CompleteProjectMutationFailureInput): Promise<"updated" | "lease_lost"> {
    const stored = this.mutations.get(input.mutationId);
    if (!stored || stored.leaseToken !== input.leaseToken
      || stored.state.fencingEpoch !== input.fencingEpoch) return "lease_lost";
    stored.state = {
      ...stored.state,
      status: input.status,
      receipt: input.receipt ?? {},
      responseStatus: input.responseStatus ?? null,
      failureCode: input.failureCode,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: FIXED_TIME,
    };
    stored.leaseToken = null;
    return "updated";
  }

  async read(_projectRef: string, mutationId: string): Promise<ProjectMutationState | null> {
    return this.mutations.get(mutationId)?.state ?? null;
  }

  async activeForDeployment(): Promise<ProjectMutationState | null> {
    return [...this.mutations.values()].find((stored) =>
      ["pending", "running", "failed_retryable", "outcome_unknown"].includes(stored.state.status))?.state ?? null;
  }

  async withLease<T>(input: {
    mutationId: string;
    leaseToken: string;
    fencingEpoch: number;
  }, operation: () => Promise<T>): Promise<{ kind: "executed"; value: T } | { kind: "lease_lost" }> {
    if (this.rejectNextLease) {
      this.rejectNextLease = false;
      return { kind: "lease_lost" };
    }
    const stored = this.mutations.get(input.mutationId);
    if (!stored || stored.leaseToken !== input.leaseToken
      || stored.state.fencingEpoch !== input.fencingEpoch || stored.state.status !== "running") {
      return { kind: "lease_lost" };
    }
    this.leaseDepth += 1;
    this.events.push(`lease:enter:${this.leaseDepth}`);
    try {
      return { kind: "executed", value: await operation() };
    } finally {
      this.events.push(`lease:exit:${this.leaseDepth}`);
      this.leaseDepth -= 1;
    }
  }
}

class MemoryGateway {
  root: string | null = null;
  failNext = false;
  failAfterApply = false;
  durabilityUnknownAfterApply = false;
  unreadableAfterFailure = false;
  writeCalls = 0;
  private readFailure = false;

  constructor(private readonly mutations: MemoryMutations) {}

  async configureFrontendRoute(route: { root: string }): Promise<void> {
    this.writeCalls += 1;
    this.mutations.events.push(`route:configure:${this.mutations.leaseDepth}`);
    if (this.durabilityUnknownAfterApply) {
      this.durabilityUnknownAfterApply = false;
      this.root = route.root;
      throw Object.assign(new Error("gateway durability unknown"), {
        code: "CADDY_GATEWAY_DURABILITY_UNKNOWN",
      });
    }
    if (this.failAfterApply) {
      this.failAfterApply = false;
      this.root = route.root;
      throw new Error("gateway response lost after apply");
    }
    if (this.failNext) {
      this.failNext = false;
      this.readFailure = this.unreadableAfterFailure;
      throw new Error("gateway failure");
    }
    this.root = route.root;
  }

  async removeFrontendRoute(): Promise<void> {
    this.writeCalls += 1;
    this.mutations.events.push(`route:remove:${this.mutations.leaseDepth}`);
    this.root = null;
  }

  async readFrontendStaticRoot(): Promise<string | null> {
    this.mutations.events.push(`route:read:${this.mutations.leaseDepth}`);
    if (this.readFailure) throw new Error("gateway readback failure");
    return this.root;
  }
}

interface AuthorityWriteProbe {
  count: number;
}

interface Fixture {
  root: string;
  service: FrontendReleaseService;
  gateway: MemoryGateway;
  mutations: MemoryMutations;
  authorityWrites: AuthorityWriteProbe;
  archive: Uint8Array;
  sha256: string;
}

interface FixtureOptions {
  interruption?: (phase: "after_prepared" | "after_authority" | "after_route") => void;
  beforePublish?: (artifactDir: string, finalDir: string) => Promise<void> | void;
}

function observeAuthorityWrites(
  service: FrontendReleaseService,
  mutations: MemoryMutations,
): AuthorityWriteProbe {
  const storage = (service as unknown as { storage: FrontendReleaseStorage }).storage;
  const writeActiveRelease = storage.writeActiveRelease.bind(storage);
  const probe = { count: 0 };
  storage.writeActiveRelease = async (
    ...args: Parameters<FrontendReleaseStorage["writeActiveRelease"]>
  ): Promise<void> => {
    probe.count += 1;
    mutations.events.push(`authority:write:${mutations.leaseDepth}`);
    await writeActiveRelease(...args);
  };
  return probe;
}

async function stagedArchive(
  service: FrontendReleaseService,
  archive: Uint8Array,
  expectedSha256: string,
) {
  const upload = await service.prepareReleaseUpload(PROJECT_REF, DEPLOYMENT_ID, archive.byteLength);
  try {
    for (let offset = 0; offset < archive.byteLength; offset += 64 * 1024) {
      await upload.write(archive.subarray(offset, offset + 64 * 1024));
    }
    return await upload.finish(expectedSha256);
  } catch (error: unknown) {
    await upload.abort();
    throw error;
  }
}

async function createFixtureRelease(service: FrontendReleaseService, source: Fixture) {
  return service.createRelease(
    PROJECT_REF,
    DEPLOYMENT_ID,
    await stagedArchive(service, source.archive, source.sha256),
  );
}

async function archiveBytes(root: string, content: string): Promise<Uint8Array> {
  const source = join(root, "source");
  const archive = join(root, "site.zip");
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, "index.html"), content);
  const zipped = await Bun.$`zip -q -X ${archive} index.html`.cwd(source).nothrow();
  if (zipped.exitCode !== 0) throw new Error("zip fixture failed");
  return new Uint8Array(await readFile(archive));
}

async function fixture(
  content = "<!doctype html><title>release</title>",
  options: FixtureOptions = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(homedir(), ".supacloud-frontend-release-test-"));
  roots.add(root);
  await chmod(root, 0o700);
  const deploymentDir = join(root, PROJECT_REF, DEPLOYMENT_ID);
  await mkdir(deploymentDir, { recursive: true, mode: 0o700 });
  await writeFile(join(deploymentDir, "deployment.json"), JSON.stringify({
    id: DEPLOYMENT_ID,
    project_ref: PROJECT_REF,
    name: "FA",
    framework: "static",
    domain: "fa.example.test",
    custom_domains: [],
    build_command: "",
    output_dir: ".",
    install_command: "",
    node_version: "20",
    env_vars: {},
    status: "success",
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    deployment_url: "https://fa.example.test",
  }));
  const mutations = new MemoryMutations();
  const gateway = new MemoryGateway(mutations);
  const archive = await archiveBytes(root, content);
  const sha = createHash("sha256").update(archive).digest("hex");
  const service = new FrontendReleaseService({
    baseDir: root,
    gateway: gateway as never,
    mutations,
    deploymentLock: async (_projectRef, _deploymentId, operation) => operation(),
    now: () => new Date(FIXED_TIME),
    interruption: options.interruption,
    beforePublish: options.beforePublish,
  });
  return {
    root,
    gateway,
    mutations,
    authorityWrites: observeAuthorityWrites(service, mutations),
    archive,
    sha256: sha,
    service,
  };
}

function activation(
  fixture: Fixture,
  overrides: Partial<Parameters<FrontendReleaseService["activateRelease"]>[0]> = {},
): Parameters<FrontendReleaseService["activateRelease"]>[0] {
  return {
    projectRef: PROJECT_REF,
    deploymentId: DEPLOYMENT_ID,
    releaseId: fixture.sha256,
    expectedActiveReleaseId: "absent",
    expectedActivationId: "absent",
    mutationId: MUTATION_ID,
    principal: { type: "project", id: `project:${PROJECT_REF}` },
    ...overrides,
  };
}

function expectActivation(response: FrontendReleaseActivation, fixture: Fixture): void {
  expect(response.active_release_id).toBe(fixture.sha256);
  expect(response.activation_id).toBe(response.mutation.mutation_id);
  expect(response.release.sha256).toBe(fixture.sha256);
  expect(response.mutation.status).toBe("succeeded");
}

function nextGenerationActivation(fixture: Fixture) {
  return activation(fixture, {
    expectedActiveReleaseId: fixture.sha256,
    expectedActivationId: MUTATION_ID,
    mutationId: SECOND_MUTATION_ID,
  });
}

function staleFirstGenerationActivation(fixture: Fixture) {
  return activation(fixture, {
    expectedActiveReleaseId: fixture.sha256,
    expectedActivationId: MUTATION_ID,
    mutationId: THIRD_MUTATION_ID,
  });
}

interface SuccessfulJournalCorruption {
  name: string;
  corrupt: (state: ProjectMutationState) => ProjectMutationState;
  replayCode: string;
}

const SUCCESSFUL_JOURNAL_CORRUPTIONS: SuccessfulJournalCorruption[] = [
  {
    name: "operation",
    corrupt: (state) => ({ ...state, operation: "frontend.release.delete" }),
    replayCode: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
  },
  {
    name: "resource key",
    corrupt: (state) => ({ ...state, resourceKey: "v1/frontend_release/YXR0YWNrZXI" }),
    replayCode: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
  },
  {
    name: "request fingerprint",
    corrupt: (state) => ({ ...state, requestFingerprint: "e".repeat(64) }),
    replayCode: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
  },
  {
    name: "principal",
    corrupt: (state) => ({ ...state, principal: { type: "project", id: "project:attacker" } }),
    replayCode: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
  },
  {
    name: "status",
    corrupt: (state) => ({ ...state, status: "failed_terminal" }),
    replayCode: "FRONTEND_RELEASE_MUTATION_FAILED",
  },
  {
    name: "response status",
    corrupt: (state) => ({ ...state, responseStatus: 201 }),
    replayCode: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
  },
  {
    name: "failure code",
    corrupt: (state) => ({ ...state, failureCode: "CORRUPTED_SUCCESS" }),
    replayCode: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
  },
  {
    name: "receipt",
    corrupt: (state) => ({ ...state, receipt: {} }),
    replayCode: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
  },
  {
    name: "checkpoint",
    corrupt: (state) => ({
      ...state,
      checkpoint: { ...state.checkpoint, phase: "authority_applied" },
    }),
    replayCode: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
  },
];

afterEach(async () => {
  const makeRemovable = async (directory: string): Promise<void> => {
    await chmod(directory, 0o700).catch(() => undefined);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) await makeRemovable(join(directory, entry.name));
    }
  };
  await Promise.all([...roots].map(async (root) => {
    await makeRemovable(root);
    await rm(root, { recursive: true, force: true });
  }));
  roots.clear();
});

describe.skipIf(process.platform !== "linux")("FrontendReleaseService", () => {
  test("creates an immutable release, inventories it, and CAS activates it", async () => {
    const prepared = await fixture();
    const created = await createFixtureRelease(prepared.service, prepared);
    expect(created.release_id).toBe(prepared.sha256);
    expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).active_release_id).toBeNull();

    const activated = await prepared.service.activateRelease(activation(prepared));
    expectActivation(activated, prepared);
    expect(prepared.gateway.root).toBe(join(
      prepared.root,
      PROJECT_REF,
      DEPLOYMENT_ID,
      "releases",
      prepared.sha256,
      "build",
    ));
    const inventory = await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID);
    expect(inventory.active_release_id).toBe(prepared.sha256);
    expect(inventory.releases).toHaveLength(1);
  });

  test("paginates multiple releases in the same release-id order as its cursor", async () => {
    const prepared = await fixture("<!doctype html><title>first</title>");
    const second = await fixture("<!doctype html><title>second</title>");
    const third = await fixture("<!doctype html><title>third</title>");
    const archives = [prepared, second, third];
    for (const candidate of archives) {
      await createFixtureRelease(prepared.service, candidate);
    }

    const expectedIds = archives.map(({ sha256 }) => sha256).sort();
    const firstPage = await prepared.service.listReleases(
      PROJECT_REF,
      DEPLOYMENT_ID,
      { limit: 2 },
    );
    expect(firstPage.releases.map(({ release_id }) => release_id)).toEqual(expectedIds.slice(0, 2));
    expect(firstPage.next_cursor).toBe(expectedIds[1]);

    const secondPage = await prepared.service.listReleases(
      PROJECT_REF,
      DEPLOYMENT_ID,
      { cursor: firstPage.next_cursor!, limit: 2 },
    );
    expect(secondPage.releases.map(({ release_id }) => release_id)).toEqual(expectedIds.slice(2));
    expect(secondPage.next_cursor).toBeNull();
  });

  test("replays the exact successful activation only after receipt and live read-back", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    expectActivation(await prepared.service.activateRelease(activation(prepared)), prepared);

    const replay = await prepared.service.activateRelease(activation(prepared));
    expect(replay.mutation.replayed).toBe(true);
    prepared.gateway.root = join(prepared.root, "attacker-controlled");
    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_READBACK_MISMATCH",
    });
  });

  for (const corruption of SUCCESSFUL_JOURNAL_CORRUPTIONS) {
    test(`fails closed for a corrupted successful ${corruption.name} on first completion and replay`, async () => {
      const prepared = await fixture();
      await createFixtureRelease(prepared.service, prepared);
      prepared.mutations.corruptNextSuccessJournal = corruption.corrupt;

      await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
        code: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
      });
      const authorityWritesAfterCompletion = prepared.authorityWrites.count;
      const gatewayWritesAfterCompletion = prepared.gateway.writeCalls;
      const eventsAfterCompletion = prepared.mutations.events.length;

      await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
        code: corruption.replayCode,
      });
      expect(prepared.authorityWrites.count).toBe(authorityWritesAfterCompletion);
      expect(prepared.gateway.writeCalls).toBe(gatewayWritesAfterCompletion);
      expect(prepared.mutations.events).toHaveLength(eventsAfterCompletion);
    });
  }

  test("rejects stale CAS before changing authority or Caddy", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    const stale = activation(prepared);
    stale.expectedActiveReleaseId = "f".repeat(64);
    await expect(prepared.service.activateRelease(stale)).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_REVISION_CONFLICT",
      statusCode: 409,
    });
    expect(prepared.gateway.root).toBeNull();
    expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).active_release_id).toBeNull();
  });

  test("rejects invalid deployment or release metadata before creating a mutation journal", async () => {
    const prepared = await fixture();
    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_NOT_FOUND",
    });
    expect(prepared.mutations.mutations.size).toBe(0);

    await createFixtureRelease(prepared.service, prepared);
    await writeFile(join(prepared.root, PROJECT_REF, DEPLOYMENT_ID, "deployment.json"), "{}\n");
    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_DEPLOYMENT_INVALID",
    });
    expect(prepared.mutations.mutations.size).toBe(0);
  });

  test("never applies authority or Caddy after losing the fenced lease", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    prepared.mutations.rejectNextLease = true;

    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
    });

    expect(prepared.gateway.root).toBeNull();
    expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).active_release_id).toBeNull();
  });

  test("rejects an A to B to A stale activation with the old activation generation", async () => {
    const prepared = await fixture();
    const second = await fixture("<!doctype html><title>second</title>");
    await createFixtureRelease(prepared.service, prepared);
    await createFixtureRelease(prepared.service, second);

    await prepared.service.activateRelease(activation(prepared));
    await prepared.service.activateRelease(activation(prepared, {
      releaseId: second.sha256,
      expectedActiveReleaseId: prepared.sha256,
      expectedActivationId: MUTATION_ID,
      mutationId: SECOND_MUTATION_ID,
    }));
    await prepared.service.activateRelease(activation(prepared, {
      expectedActiveReleaseId: second.sha256,
      expectedActivationId: SECOND_MUTATION_ID,
      mutationId: THIRD_MUTATION_ID,
    }));

    await expect(prepared.service.activateRelease(activation(prepared, {
      expectedActiveReleaseId: prepared.sha256,
      expectedActivationId: MUTATION_ID,
      mutationId: "00000000-0000-4000-8000-000000000004",
    }))).rejects.toMatchObject({ code: "FRONTEND_RELEASE_REVISION_CONFLICT" });
    const inventory = await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID);
    expect(inventory.active_release_id).toBe(prepared.sha256);
    expect(inventory.active_activation_id).toBe(THIRD_MUTATION_ID);
  });

  test("advances the activation generation without changing the content-addressed root", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    await prepared.service.activateRelease(activation(prepared));
    const firstGenerationRoot = prepared.gateway.root;

    const secondGeneration = await prepared.service.activateRelease(nextGenerationActivation(prepared));
    expect(secondGeneration.activation_id).toBe(SECOND_MUTATION_ID);
    expect(secondGeneration.active_release_id).toBe(prepared.sha256);
    expect(prepared.gateway.root).toBe(firstGenerationRoot);
    const inventory = await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID);
    expect(inventory.active_release_id).toBe(prepared.sha256);
    expect(inventory.active_activation_id).toBe(SECOND_MUTATION_ID);

    await expect(prepared.service.activateRelease(staleFirstGenerationActivation(prepared)))
      .rejects.toMatchObject({ code: "FRONTEND_RELEASE_REVISION_CONFLICT" });
    expect(prepared.mutations.mutations.has(THIRD_MUTATION_ID)).toBe(false);
  });

  for (const interruptedPhase of ["after_prepared", "after_authority", "after_route"] as const) {
    test(`recovers a same-release generation after a crash at ${interruptedPhase}`, async () => {
      let armed = false;
      let interrupted = false;
      const prepared = await fixture(undefined, {
        interruption: (phase) => {
          if (armed && !interrupted && phase === interruptedPhase) {
            interrupted = true;
            throw new Error("simulated process crash");
          }
        },
      });
      await createFixtureRelease(prepared.service, prepared);
      await prepared.service.activateRelease(activation(prepared));
      const firstGenerationRoot = prepared.gateway.root;
      armed = true;

      await expect(prepared.service.activateRelease(nextGenerationActivation(prepared)))
        .rejects.toMatchObject({ code: "FRONTEND_RELEASE_ACTIVATION_RETRYABLE" });
      expect(prepared.mutations.mutations.get(SECOND_MUTATION_ID)?.state.status)
        .toBe("failed_retryable");

      const recovered = await prepared.service.activateRelease(nextGenerationActivation(prepared));
      expect(recovered.activation_id).toBe(SECOND_MUTATION_ID);
      expect(recovered.active_release_id).toBe(prepared.sha256);
      expect(prepared.gateway.root).toBe(firstGenerationRoot);
      expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).active_activation_id)
        .toBe(SECOND_MUTATION_ID);
      await expect(prepared.service.activateRelease(staleFirstGenerationActivation(prepared)))
        .rejects.toMatchObject({ code: "FRONTEND_RELEASE_REVISION_CONFLICT" });
    });
  }

  test("restores old authority and records a terminal failure when Caddy keeps the old root", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    prepared.gateway.failNext = true;
    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_ROUTE_REJECTED",
    });
    expect(prepared.gateway.root).toBeNull();
    expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).active_release_id).toBeNull();
    expect(prepared.mutations.mutations.get(MUTATION_ID)?.state).toMatchObject({
      status: "failed_terminal",
      checkpoint: { phase: "authority_applied", release_id: prepared.sha256 },
    });
    const routeFailureStart = prepared.mutations.events.indexOf("route:configure:1") - 1;
    expect(prepared.mutations.events.slice(routeFailureStart)).toEqual([
      "lease:enter:1",
      "route:configure:1",
      "route:read:1",
      "authority:write:1",
      "lease:exit:1",
    ]);
  });

  test("finishes activation when Caddy applied the desired root before losing its response", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    prepared.gateway.failAfterApply = true;

    expectActivation(await prepared.service.activateRelease(activation(prepared)), prepared);
    expect(prepared.mutations.mutations.get(MUTATION_ID)?.state.status).toBe("succeeded");
    expect(prepared.gateway.root).toContain(prepared.sha256);
  });

  test("records outcome_unknown when the desired Caddy root is live but durability is unknown", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    prepared.gateway.durabilityUnknownAfterApply = true;

    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
    });
    expect(prepared.gateway.root).toContain(prepared.sha256);
    expect(prepared.mutations.mutations.get(MUTATION_ID)?.state).toMatchObject({
      status: "outcome_unknown",
      receipt: expect.not.objectContaining({ active_release_id: prepared.sha256 }),
    });
  });

  for (const phase of ["authority_applied", "route_applied"] as const) {
    test(`re-drives ${phase} checkpoint after authority and route drift back to previous state`, async () => {
      let interrupted = false;
      const prepared = await fixture(undefined, {
        interruption: (currentPhase) => {
          if (!interrupted && currentPhase === (phase === "authority_applied" ? "after_authority" : "after_route")) {
            interrupted = true;
            throw new Error("simulated process crash");
          }
        },
      });
      await createFixtureRelease(prepared.service, prepared);
      await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
        code: "FRONTEND_RELEASE_ACTIVATION_RETRYABLE",
      });
      await rm(join(prepared.root, PROJECT_REF, DEPLOYMENT_ID, "active-release.json"));
      prepared.gateway.root = null;

      expectActivation(await prepared.service.activateRelease(activation(prepared)), prepared);
      expect(prepared.mutations.mutations.get(MUTATION_ID)?.state).toMatchObject({
        status: "succeeded",
        checkpoint: { phase: "route_applied" },
      });
    });
  }

  test("terminalizes an unreconcilable recovery drift instead of retrying forever", async () => {
    let interrupted = false;
    const prepared = await fixture(undefined, {
      interruption: (phase) => {
        if (!interrupted && phase === "after_route") {
          interrupted = true;
          throw new Error("simulated process crash");
        }
      },
    });
    await createFixtureRelease(prepared.service, prepared);
    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_ACTIVATION_RETRYABLE",
    });
    prepared.gateway.root = join(prepared.root, "unrelated-live-root");

    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
    });
    expect(prepared.mutations.mutations.get(MUTATION_ID)?.state.status).toBe("outcome_unknown");
  });

  test("records outcome_unknown without a successful receipt when Caddy readback fails", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    prepared.gateway.failNext = true;
    prepared.gateway.unreadableAfterFailure = true;

    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_OUTCOME_UNKNOWN",
    });
    expect(prepared.mutations.mutations.get(MUTATION_ID)?.state).toMatchObject({
      status: "outcome_unknown",
      receipt: expect.not.objectContaining({ active_release_id: prepared.sha256 }),
    });
  });

  test("fails inventory closed after immutable artifact tampering", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    const buildFile = join(
      prepared.root,
      PROJECT_REF,
      DEPLOYMENT_ID,
      "releases",
      prepared.sha256,
      "build",
      "index.html",
    );
    await chmod(buildFile, 0o644);
    await writeFile(buildFile, "attacker-controlled");
    await expect(prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).rejects.toBeInstanceOf(FrontendReleaseError);
  });

  test("rejects split active authority before inventory, build lookup, or Gateway mutation", async () => {
    const prepared = await fixture();
    await createFixtureRelease(prepared.service, prepared);
    await prepared.service.activateRelease(activation(prepared));
    const authorityPath = join(prepared.root, PROJECT_REF, DEPLOYMENT_ID, "active-release.json");
    const authority = JSON.parse(await readFile(authorityPath, "utf8"));
    authority.activation_id = SECOND_MUTATION_ID;
    await chmod(authorityPath, 0o644);
    await writeFile(authorityPath, `${JSON.stringify(authority)}\n`);
    prepared.gateway.root = null;

    await expect(prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID))
      .rejects.toMatchObject({ code: "FRONTEND_RELEASE_AUTHORITY_INVALID" });
    await expect(prepared.service.activeBuildDir(PROJECT_REF, DEPLOYMENT_ID))
      .rejects.toMatchObject({ code: "FRONTEND_RELEASE_AUTHORITY_INVALID" });
    await expect(prepared.service.activateRelease(activation(prepared, {
      mutationId: SECOND_MUTATION_ID,
      expectedActiveReleaseId: prepared.sha256,
      expectedActivationId: MUTATION_ID,
    }))).rejects.toMatchObject({ code: "FRONTEND_RELEASE_AUTHORITY_INVALID" });
    expect(prepared.gateway.root).toBeNull();
    expect(prepared.mutations.mutations.has(SECOND_MUTATION_ID)).toBe(false);
  });

  test("rejects a digest mismatch without creating an inventory entry", async () => {
    const prepared = await fixture();
    await expect(stagedArchive(
      prepared.service,
      prepared.archive,
      "0".repeat(64),
    )).rejects.toMatchObject({ code: "FRONTEND_RELEASE_SHA_MISMATCH" });
    expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).releases).toEqual([]);
  });

  test("cleans incomplete upload sessions and keeps concurrent staging isolated", async () => {
    const prepared = await fixture();
    const first = await prepared.service.prepareReleaseUpload(
      PROJECT_REF,
      DEPLOYMENT_ID,
      prepared.archive.byteLength,
    );
    const second = await prepared.service.prepareReleaseUpload(
      PROJECT_REF,
      DEPLOYMENT_ID,
      prepared.archive.byteLength,
    );
    await first.write(prepared.archive.subarray(0, 1));
    await first.abort();
    await second.write(prepared.archive);
    const staged = await second.finish(prepared.sha256);
    expect((await prepared.service.createRelease(PROJECT_REF, DEPLOYMENT_ID, staged)).release_id)
      .toBe(prepared.sha256);
    expect(await readdir(join(
      prepared.root,
      PROJECT_REF,
      DEPLOYMENT_ID,
      "releases",
      ".staging",
    ))).toEqual([]);
  });

  test("rejects a staged archive path replacement and removes only its bound session", async () => {
    const prepared = await fixture();
    const upload = await prepared.service.prepareReleaseUpload(
      PROJECT_REF,
      DEPLOYMENT_ID,
      prepared.archive.byteLength,
    );
    await upload.write(prepared.archive);
    const staged = await upload.finish(prepared.sha256);
    const stagingRoot = join(prepared.root, PROJECT_REF, DEPLOYMENT_ID, "releases", ".staging");
    const [sessionName] = await readdir(stagingRoot);
    const archivePath = join(stagingRoot, sessionName, "archive.zip");
    await rename(archivePath, `${archivePath}.moved`);
    await writeFile(archivePath, "attacker-controlled");

    await expect(prepared.service.createRelease(PROJECT_REF, DEPLOYMENT_ID, staged))
      .rejects.toMatchObject({ code: "FRONTEND_RELEASE_STORAGE_UNTRUSTED" });
    expect(await readdir(stagingRoot)).toEqual([]);
    expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).releases).toEqual([]);
  });

  for (const interruptedPhase of ["after_prepared", "after_authority", "after_route"] as const) {
    test(`recovers the exact terminal state after a crash at ${interruptedPhase}`, async () => {
      let interrupted = false;
      const prepared = await fixture(undefined, {
        interruption: (phase) => {
          if (!interrupted && phase === interruptedPhase) {
            interrupted = true;
            throw new Error("simulated process crash");
          }
        },
      });
      await createFixtureRelease(prepared.service, prepared);
      await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
        code: "FRONTEND_RELEASE_ACTIVATION_RETRYABLE",
      });
      expect(prepared.mutations.mutations.get(MUTATION_ID)?.state.status).toBe("failed_retryable");

      const recovered = await prepared.service.activateRelease(activation(prepared));
      expectActivation(recovered, prepared);
      expect(prepared.mutations.mutations.get(MUTATION_ID)?.state.status).toBe("succeeded");
      expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).active_release_id)
        .toBe(prepared.sha256);
      expect(prepared.gateway.root).toBe(join(
        prepared.root,
        PROJECT_REF,
        DEPLOYMENT_ID,
        "releases",
        prepared.sha256,
        "build",
      ));
    });
  }

  test.skipIf(process.platform !== "linux")(
    "concurrent service instances converge on the same content-addressed release",
    async () => {
    const prepared = await fixture();
    const second = new FrontendReleaseService({
      baseDir: prepared.root,
      gateway: prepared.gateway as never,
      mutations: prepared.mutations,
      deploymentLock: async (_projectRef, _deploymentId, operation) => operation(),
      now: () => new Date(FIXED_TIME),
    });
    const [left, right] = await Promise.all([
      createFixtureRelease(prepared.service, prepared),
      createFixtureRelease(second, prepared),
    ]);
    expect(left).toEqual(right);
    expect((await prepared.service.listReleases(PROJECT_REF, DEPLOYMENT_ID)).releases).toHaveLength(1);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "fails closed when an ancestor is replaced before immutable publish",
    async () => {
    let movedRoot = "";
    const prepared = await fixture(undefined, {
      beforePublish: async () => {
        movedRoot = `${prepared.root}-moved`;
        roots.add(movedRoot);
        await rename(prepared.root, movedRoot);
        await mkdir(prepared.root, { mode: 0o700 });
      },
    });
    await expect(createFixtureRelease(prepared.service, prepared))
      .rejects.toMatchObject({ code: "FRONTEND_RELEASE_STORAGE_UNTRUSTED" });
    await expect(readdir(join(
      prepared.root,
      PROJECT_REF,
      DEPLOYMENT_ID,
      "releases",
    ))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

});

test.skipIf(process.platform === "linux")(
  "rejects immutable release writes before publish on unsupported platforms",
  async () => {
    const prepared = await fixture();
    await expect(createFixtureRelease(prepared.service, prepared))
      .rejects.toMatchObject({ code: "FRONTEND_RELEASE_STORAGE_PLATFORM_UNSUPPORTED" });
    expect(prepared.mutations.mutations).toHaveLength(0);
    await expect(prepared.service.activateRelease(activation(prepared))).rejects.toMatchObject({
      code: "FRONTEND_RELEASE_STORAGE_PLATFORM_UNSUPPORTED",
    });
    expect(prepared.mutations.mutations).toHaveLength(0);
    expect(prepared.gateway.root).toBeNull();
    expect(await readdir(join(prepared.root, PROJECT_REF, DEPLOYMENT_ID))).toEqual(["deployment.json"]);
  },
);
