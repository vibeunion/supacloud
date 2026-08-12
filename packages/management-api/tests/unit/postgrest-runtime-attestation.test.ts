import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { link, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activatePostgrestGeneration,
  readPostgrestPointerTarget,
  replacePostgrestPointer,
  validatePostgrestGenerationTarget,
} from "../../src/services/postgrest-generation";
import {
  attestPostgrestRuntime,
  parsePostgrestSystemdShow,
  type PostgrestAttestationOperations,
  type PostgrestAttestationRequest,
  type PostgrestProcessIdentity,
  type PostgrestSystemdActivity,
  type SystemdProcessIdentity,
} from "../../src/services/postgrest-runtime-attestation";
import { postgrestConfigRevision } from "../../src/services/runtime-revision";

const PROJECT_REF = "afemibrarjkvzuuawjfi";
const ACTIVE_IDENTITY: SystemdProcessIdentity = {
  activity: "active",
  mainPid: 4172,
  invocationId: "a".repeat(32),
  startMonotonic: "123456789",
  loadedAt: "2026-08-11T00:00:00.000Z",
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function currentUid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 0;
}

function currentGid(): number {
  return typeof process.getgid === "function" ? process.getgid() : 0;
}

async function tenantDirectory(): Promise<string> {
  const createdDirectory = await mkdtemp(join(tmpdir(), "supacloud-postgrest-attestation-"));
  const canonicalDirectory = await realpath(createdDirectory);
  temporaryDirectories.push(canonicalDirectory);
  return canonicalDirectory;
}

function request(
  directory: string,
  desiredRevision: string | null,
  postgrestBinary = process.execPath,
): PostgrestAttestationRequest {
  return {
    projectRef: PROJECT_REF,
    desiredRevision,
    port: 3101,
    unit: `supacloud-pgrst@${PROJECT_REF}`,
    tenantDirectory: directory,
    postgrestBinary,
    controlOwnerUid: currentUid(),
  };
}

function stoppedOperations(
  activity: PostgrestSystemdActivity,
  mainPid = 0,
): PostgrestAttestationOperations {
  return {
    runtimeGroupGid: async () => currentGid(),
    systemdMainProcess: async () => ({
      ...ACTIVE_IDENTITY,
      activity,
      mainPid,
      loadedAt: null,
    }),
    processIdentity: async () => {
      throw new Error("process identity must not be read for a non-active unit");
    },
    health: async () => {
      throw new Error("health must not be probed for a non-active unit");
    },
  };
}

async function activeFixture(content = "db-pool = 10\n") {
  const directory = await tenantDirectory();
  const activated = await activatePostgrestGeneration({
    tenantDirectory: directory,
    projectRef: PROJECT_REF,
    content,
    controlOwnerUid: currentUid(),
    runtimeGroupGid: currentGid(),
    setControlOwnership: async () => {},
  });
  const executable = await realpath(process.execPath);
  let loadedConfigPath = activated.layout.generationPath;
  const processIdentity = (): PostgrestProcessIdentity => ({
    startId: "987654321",
    executable,
    commandLine: [executable, loadedConfigPath],
    environmentNames: [],
  });
  const operations: PostgrestAttestationOperations = {
    runtimeGroupGid: async () => currentGid(),
    systemdMainProcess: async () => ACTIVE_IDENTITY,
    processIdentity: async () => processIdentity(),
    health: async () => "healthy",
  };
  return {
    activated,
    directory,
    operations,
    setLoadedConfigPath(path: string) {
      loadedConfigPath = path;
    },
  };
}

function validateActiveGeneration(fixture: Awaited<ReturnType<typeof activeFixture>>) {
  return validatePostgrestGenerationTarget(
    fixture.directory,
    PROJECT_REF,
    fixture.activated.layout.pointerTarget,
    fixture.activated.ownership,
  );
}

async function setFixtureMode(path: string, mode: number): Promise<void> {
  const octalMode = mode.toString(8);
  const chmod = spawnSync("/bin/chmod", [octalMode, path]);
  if (chmod.status !== 0) throw new Error(`Cannot set fixture mode ${octalMode}`);
  expect((await lstat(path)).mode & 0o7777).toBe(mode);
}

describe("PostgREST systemd identity parser", () => {
  test("parses a canonical active process identity", () => {
    expect(parsePostgrestSystemdShow([
      "ActiveState=active",
      "MainPID=4172",
      `InvocationID=${"a".repeat(32)}`,
      "ExecMainStartTimestampMonotonic=123456789",
      "ExecMainStartTimestamp=2026-08-11T00:00:00.000Z",
    ].join("\n"))).toEqual(ACTIVE_IDENTITY);
  });

  test("rejects missing identities and inactive units with a live PID", () => {
    expect(() => parsePostgrestSystemdShow("")).toThrow("Invalid systemd MainPID");
    expect(() => parsePostgrestSystemdShow([
      "ActiveState=active",
      "MainPID=0",
      "InvocationID=",
      "ExecMainStartTimestampMonotonic=",
    ].join("\n"))).toThrow("Invalid active systemd process identity");
    expect(() => parsePostgrestSystemdShow([
      "ActiveState=inactive",
      "MainPID=4172",
    ].join("\n"))).toThrow("Inactive systemd unit reported a main process");
  });
});

describe("PostgREST runtime attestation", () => {
  test("rejects special permission bits on control files and directories", async () => {
    const fixture = await activeFixture();
    for (const specialBit of [0o4000, 0o2000, 0o1000]) {
      await setFixtureMode(fixture.activated.layout.generationPath, 0o440 | specialBit);
      await expect(validateActiveGeneration(fixture)).rejects.toThrow("unsafe metadata");
      await setFixtureMode(fixture.activated.layout.generationPath, 0o440);

      await setFixtureMode(fixture.activated.layout.generationDirectory, 0o750 | specialBit);
      await expect(validateActiveGeneration(fixture)).rejects.toThrow("unsafe metadata");
      await setFixtureMode(fixture.activated.layout.generationDirectory, 0o750);
    }
  });

  test("rejects a hard-linked control file", async () => {
    const fixture = await activeFixture();
    await link(
      fixture.activated.layout.generationPath,
      join(fixture.directory, "hard-linked-generation.conf"),
    );

    await expect(validateActiveGeneration(fixture)).rejects.toThrow("unsafe metadata");
  });

  test("does not replace a generation that changed before activation", async () => {
    const fixture = await activeFixture("db-pool = 10\n");
    const concurrent = await activatePostgrestGeneration({
      tenantDirectory: fixture.directory,
      projectRef: PROJECT_REF,
      content: "db-pool = 20\n",
      controlOwnerUid: currentUid(),
      runtimeGroupGid: currentGid(),
      setControlOwnership: async () => {},
    });

    await expect(activatePostgrestGeneration({
      tenantDirectory: fixture.directory,
      projectRef: PROJECT_REF,
      content: "db-pool = 30\n",
      expectedPreviousPointerTarget: fixture.activated.layout.pointerTarget,
      controlOwnerUid: currentUid(),
      runtimeGroupGid: currentGid(),
      setControlOwnership: async () => {},
    })).rejects.toThrow("changed before activation");

    expect(await readPostgrestPointerTarget(
      concurrent.layout.pointerPath,
      PROJECT_REF,
      concurrent.ownership,
    )).toBe(concurrent.layout.pointerTarget);
  });

  test("attests an active process bound to the authoritative generation", async () => {
    const fixture = await activeFixture();
    const snapshot = await attestPostgrestRuntime(
      request(fixture.directory, fixture.activated.revision),
      fixture.operations,
    );

    expect(snapshot).toEqual({
      desiredRevision: fixture.activated.revision,
      loadedRevision: fixture.activated.revision,
      attestationState: "loaded",
      matchesDesired: true,
      actual: "running",
      health: "healthy",
      loadedAt: ACTIVE_IDENTITY.loadedAt,
    });
  });

  test("reports an inactive PID-zero unit as stopped", async () => {
    const directory = await tenantDirectory();
    const desiredRevision = postgrestConfigRevision(PROJECT_REF, "authority\n");

    expect(await attestPostgrestRuntime(
      request(directory, desiredRevision),
      stoppedOperations("inactive"),
    )).toEqual({
      desiredRevision,
      loadedRevision: null,
      attestationState: "stopped",
      matchesDesired: null,
      actual: "stopped",
      health: "unknown",
      loadedAt: null,
    });
  });

  test("maps transitional and failed systemd states without probing a process", async () => {
    const directory = await tenantDirectory();
    const desiredRevision = postgrestConfigRevision(PROJECT_REF, "authority\n");

    for (const activity of ["activating", "reloading", "deactivating"] as const) {
      const snapshot = await attestPostgrestRuntime(
        request(directory, desiredRevision),
        stoppedOperations(activity),
      );
      expect(snapshot).toMatchObject({
        desiredRevision,
        attestationState: "unreachable",
        actual: "starting",
        health: "unknown",
      });
    }

    expect(await attestPostgrestRuntime(
      request(directory, desiredRevision),
      stoppedOperations("failed"),
    )).toMatchObject({
      desiredRevision,
      attestationState: "unreachable",
      actual: "error",
      health: "unhealthy",
    });
  });

  test("keeps authority revision independent from pointer and loaded revisions", async () => {
    const fixture = await activeFixture("db-pool = 10\n");
    const pointerA = fixture.activated;
    const loadedB = await activatePostgrestGeneration({
      tenantDirectory: fixture.directory,
      projectRef: PROJECT_REF,
      content: "db-pool = 20\n",
      controlOwnerUid: currentUid(),
      runtimeGroupGid: currentGid(),
      setControlOwnership: async () => {},
    });
    await replacePostgrestPointer(
      loadedB.layout,
      pointerA.layout.pointerTarget,
      loadedB.ownership,
      async () => {},
    );
    fixture.setLoadedConfigPath(loadedB.layout.generationPath);
    const authorityRevision = postgrestConfigRevision(PROJECT_REF, "db-pool = 30\n");

    expect(await attestPostgrestRuntime(
      request(fixture.directory, authorityRevision),
      fixture.operations,
    )).toMatchObject({
      desiredRevision: authorityRevision,
      loadedRevision: loadedB.revision,
      attestationState: "stale",
      matchesDesired: false,
    });
  });

  test("retains authority desired revision for a pointerless legacy process", async () => {
    const fixture = await activeFixture();
    await rm(fixture.activated.layout.pointerPath);
    fixture.setLoadedConfigPath(join(fixture.directory, `${PROJECT_REF}.conf`));
    const authorityRevision = postgrestConfigRevision(PROJECT_REF, "authority\n");

    expect(await attestPostgrestRuntime(
      request(fixture.directory, authorityRevision),
      fixture.operations,
    )).toMatchObject({
      desiredRevision: authorityRevision,
      loadedRevision: null,
      attestationState: "unverified_legacy",
      matchesDesired: null,
    });
  });

  test("fails closed when systemd reports an impossible state", async () => {
    const directory = await tenantDirectory();
    const desiredRevision = postgrestConfigRevision(PROJECT_REF, "authority\n");
    const operations = stoppedOperations("inactive");
    operations.systemdMainProcess = async () => parsePostgrestSystemdShow([
      "ActiveState=inactive",
      "MainPID=4172",
    ].join("\n"));

    expect(await attestPostgrestRuntime(
      request(directory, desiredRevision),
      operations,
    )).toMatchObject({
      desiredRevision,
      attestationState: "unreachable",
      actual: "error",
      health: "unknown",
    });
  });
});
