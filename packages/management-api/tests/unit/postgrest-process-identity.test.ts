import { describe, expect, test } from "bun:test";
import {
  POSTGREST_PROCESS_IDENTITY_PROBE_FLAG,
  POSTGREST_PROCESS_IDENTITY_TERMINATE_FLAG,
  POSTGREST_PROCESS_IDENTITY_STDOUT_LIMIT,
  buildPostgrestProcessIdentityProbeCommand,
  buildPostgrestProcessIdentityTerminationCommand,
  collectPostgrestProcessIdentity,
  parsePostgrestProcessIdentityProbeOutput,
  probePostgrestProcessIdentity,
  terminatePostgrestIdentityProbe,
  terminatePostgrestIdentityProbeByPidfd,
  type PostgrestProcessIdentityCollectorOperations,
  type PostgrestProcessIdentityParentOperations,
  type PostgrestProcessIdentityTerminationOperations,
  type SpawnedPostgrestIdentityProbe,
} from "../../src/services/postgrest-process-identity";
import type { LinuxPidfdOperations } from "../../src/services/linux-pidfd";

const PID = 4172;
const UID = 981;
const GID = 981;
const SECRET_VALUE = "must-never-leave-the-probe";

function bytes(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function probeStatus(groups = "", effectiveCapabilities = "0000000000000000"): Buffer {
  return bytes([
    "Name:\tprobe",
    `Uid:\t${UID}\t${UID}\t${UID}\t${UID}`,
    `Gid:\t${GID}\t${GID}\t${GID}\t${GID}`,
    `Groups:\t${groups}`,
    "CapInh:\t0000000000000000",
    "CapPrm:\t0000000000000000",
    `CapEff:\t${effectiveCapabilities}`,
    "CapBnd:\t00000000000000cb",
    "CapAmb:\t0000000000000000",
    "",
  ].join("\n"));
}

function collectorOperations(overrides: Partial<PostgrestProcessIdentityCollectorOperations> = {}) {
  let statReads = 0;
  const operations: PostgrestProcessIdentityCollectorOperations = {
    currentUid: () => UID,
    currentGid: () => GID,
    async readLink(path) {
      expect(path).toBe(`/proc/${PID}/exe`);
      return "/usr/bin/postgrest";
    },
    async readFile(path) {
      if (path === "/proc/self/status") {
        return probeStatus();
      }
      if (path === `/proc/${PID}/status`) {
        return bytes(`Name:\tpostgrest\nUid:\t${UID}\t${UID}\t${UID}\t${UID}\nGid:\t${GID}\t${GID}\t${GID}\t${GID}\nGroups:\t${GID}\n`);
      }
      if (path === `/proc/${PID}/stat`) {
        statReads += 1;
        const startId = statReads === 1 ? "987654321" : "987654321";
        return bytes(`${PID} (postgrest worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${startId} 20 21\n`);
      }
      if (path === `/proc/${PID}/cmdline`) {
        return bytes(`/usr/bin/postgrest\0/var/lib/supacloud/tenants/example.conf\0`);
      }
      if (path === `/proc/${PID}/environ`) {
        return bytes(`PGRST_DB_URI=${SECRET_VALUE}\0SAFE_NAME=value\0`);
      }
      throw new Error(`Unexpected path: ${path}`);
    },
    ...overrides,
  };
  return operations;
}

function stream(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream();
}

function completedChild(
  stdout: string,
  stderr = "",
  exitCode = 0,
): SpawnedPostgrestIdentityProbe {
  return {
    pid: PID + 1,
    startId: "123456789",
    stdout: stream(stdout),
    stderr: stream(stderr),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  };
}

function parentOperations(
  child: SpawnedPostgrestIdentityProbe,
  metadata = { uid: UID, gid: GID, dev: 1, ino: 99, isDirectory: true },
): PostgrestProcessIdentityParentOperations {
  return {
    async processMetadata(pid) {
      expect(pid).toBe(PID);
      return metadata;
    },
    async executablePath() {
      return "/usr/local/bin/supacloud";
    },
    async spawn(command, options) {
      expect(options).toEqual({
        cwd: "/",
        environment: { LANG: "C", LC_ALL: "C" },
        stdin: "ignore",
      });
      expect(command).toEqual(buildPostgrestProcessIdentityProbeCommand(
        "/usr/local/bin/supacloud",
        PID,
        { uid: UID, gid: GID },
      ));
      return child;
    },
  };
}

const validProbeOutput = `${JSON.stringify({
  version: 1,
  startId: "987654321",
  executable: "/usr/bin/postgrest",
  commandLine: ["/usr/bin/postgrest", "/var/lib/supacloud/tenants/example.conf"],
  environmentNames: ["PGRST_DB_URI", "SAFE_NAME"],
})}\n`;

describe("PostgREST same-UID process identity probe", () => {
  test("builds a fixed setpriv command with exact uid/gid and cleared groups", () => {
    expect(buildPostgrestProcessIdentityProbeCommand(
      "/usr/local/bin/supacloud",
      PID,
      { uid: UID, gid: GID },
    )).toEqual([
      "/usr/bin/setpriv",
      "--reuid",
      String(UID),
      "--regid",
      String(GID),
      "--clear-groups",
      "--",
      "/usr/local/bin/supacloud",
      POSTGREST_PROCESS_IDENTITY_PROBE_FLAG,
      String(PID),
      String(UID),
      String(GID),
    ]);

    expect(buildPostgrestProcessIdentityTerminationCommand(
      "/usr/local/bin/supacloud",
      completedChild(validProbeOutput),
      { uid: UID, gid: GID },
    )).toEqual([
      "/usr/bin/setpriv",
      "--reuid",
      String(UID),
      "--regid",
      String(GID),
      "--clear-groups",
      "--",
      "/usr/local/bin/supacloud",
      POSTGREST_PROCESS_IDENTITY_TERMINATE_FLAG,
      String(PID + 1),
      String(UID),
      String(GID),
      "123456789",
    ]);
  });

  test("binds termination to a pidfd and revalidates start identity before signaling", async () => {
    const calls: string[] = [];
    const pidfdOperations: LinuxPidfdOperations = {
      open(pid) {
        calls.push(`open:${pid}`);
        return 73;
      },
      sendSignal(pidfd, signal) {
        calls.push(`signal:${pidfd}:${signal}`);
        return 0;
      },
      close(pidfd) {
        calls.push(`close:${pidfd}`);
      },
    };
    const baseCollector = collectorOperations();
    const recordingCollector = collectorOperations({
      async readFile(path, limit) {
        if (path === `/proc/${PID}/stat`) calls.push("read:stat");
        return baseCollector.readFile(path, limit);
      },
    });
    await terminatePostgrestIdentityProbeByPidfd(
      [String(PID), String(UID), String(GID), "987654321"],
      recordingCollector,
      pidfdOperations,
    );
    expect(calls).toEqual([`open:${PID}`, "read:stat", "read:stat", "signal:73:9", "close:73"]);

    calls.length = 0;
    await expect(terminatePostgrestIdentityProbeByPidfd(
      [String(PID), String(UID), String(GID), "987654320"],
      collectorOperations(),
      pidfdOperations,
    )).rejects.toThrow("changed before termination");
    expect(calls).toEqual([`open:${PID}`, "close:73"]);
  });

  test("collects only executable, argv, start identity, and environment names", async () => {
    const identity = await collectPostgrestProcessIdentity(
      [String(PID), String(UID), String(GID)],
      collectorOperations(),
    );
    expect(identity).toEqual({
      version: 1,
      startId: "987654321",
      executable: "/usr/bin/postgrest",
      commandLine: ["/usr/bin/postgrest", "/var/lib/supacloud/tenants/example.conf"],
      environmentNames: ["PGRST_DB_URI", "SAFE_NAME"],
    });
    expect(JSON.stringify(identity)).not.toContain(SECRET_VALUE);
  });

  test("rejects malformed ids, retained supplementary groups, and target identity drift", async () => {
    await expect(collectPostgrestProcessIdentity(
      ["0", String(UID), String(GID)],
      collectorOperations(),
    )).rejects.toThrow("Invalid PostgREST process identity probe arguments");
    await expect(collectPostgrestProcessIdentity(
      [String(PID), "0", String(GID)],
      collectorOperations(),
    )).rejects.toThrow("Invalid PostgREST process identity probe arguments");

    await expect(collectPostgrestProcessIdentity(
      [String(PID), String(UID), String(GID)],
      collectorOperations({
        async readFile(path, limit) {
          if (path === `/proc/${PID}/stat`) {
            return bytes(`${PID + 1} (postgrest) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654321 20\n`);
          }
          return collectorOperations().readFile(path, limit);
        },
      }),
    )).rejects.toThrow("unexpected process id");

    await expect(collectPostgrestProcessIdentity(
      [String(PID), String(UID), String(GID)],
      collectorOperations({
        async readFile(path, limit) {
          if (path === "/proc/self/status") {
            return probeStatus("27");
          }
          return collectorOperations().readFile(path, limit);
        },
      }),
    )).rejects.toThrow("supplementary groups");

    await expect(collectPostgrestProcessIdentity(
      [String(PID), String(UID), String(GID)],
      collectorOperations({
        async readFile(path, limit) {
          if (path === "/proc/self/status") return probeStatus("", "0000000000000080");
          return collectorOperations().readFile(path, limit);
        },
      }),
    )).rejects.toThrow("retained process capabilities");

    let statReads = 0;
    await expect(collectPostgrestProcessIdentity(
      [String(PID), String(UID), String(GID)],
      collectorOperations({
        async readFile(path, limit) {
          if (path === `/proc/${PID}/stat`) {
            statReads += 1;
            const startId = statReads === 1 ? "987654321" : "987654322";
            return bytes(`${PID} (postgrest) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${startId} 20\n`);
          }
          return collectorOperations().readFile(path, limit);
        },
      }),
    )).rejects.toThrow("changed during identity probe");
  });

  test("strictly parses the versioned bounded output schema", () => {
    expect(parsePostgrestProcessIdentityProbeOutput(bytes(validProbeOutput))).toEqual({
      startId: "987654321",
      executable: "/usr/bin/postgrest",
      commandLine: ["/usr/bin/postgrest", "/var/lib/supacloud/tenants/example.conf"],
      environmentNames: ["PGRST_DB_URI", "SAFE_NAME"],
    });
    expect(() => parsePostgrestProcessIdentityProbeOutput(bytes(
      `${JSON.stringify({ ...JSON.parse(validProbeOutput), unexpected: true })}\n`,
    ))).toThrow("Invalid PostgREST process identity probe output");
    expect(() => parsePostgrestProcessIdentityProbeOutput(bytes(
      `${JSON.stringify({ ...JSON.parse(validProbeOutput), startId: "01" })}\n`,
    ))).toThrow("Invalid PostgREST process identity probe output");
    expect(() => parsePostgrestProcessIdentityProbeOutput(bytes("{}"))).toThrow(
      "Invalid PostgREST process identity probe output",
    );
  });

  test("validates process ownership before and after a successful bounded probe", async () => {
    expect(await probePostgrestProcessIdentity(
      PID,
      { uid: UID, gid: GID },
      parentOperations(completedChild(validProbeOutput)),
    )).toEqual({
      startId: "987654321",
      executable: "/usr/bin/postgrest",
      commandLine: ["/usr/bin/postgrest", "/var/lib/supacloud/tenants/example.conf"],
      environmentNames: ["PGRST_DB_URI", "SAFE_NAME"],
    });

    await expect(probePostgrestProcessIdentity(
      PID,
      { uid: UID, gid: GID },
      parentOperations(completedChild(validProbeOutput), {
        uid: 999,
        gid: GID,
        dev: 1,
        ino: 99,
        isDirectory: true,
      }),
    )).rejects.toThrow("unexpected owner");
  });

  test("kills and rejects timed-out or oversized probe output without echoing stderr", async () => {
    let killed = false;
    let finish!: (code: number) => void;
    let closeStdout!: () => void;
    let closeStderr!: () => void;
    const hangingChild: SpawnedPostgrestIdentityProbe = {
      pid: PID + 1,
      startId: "123456789",
      stdout: new ReadableStream({ start(controller) { closeStdout = () => controller.close(); } }),
      stderr: new ReadableStream({ start(controller) { closeStderr = () => controller.close(); } }),
      exited: new Promise((resolve) => { finish = resolve; }),
      kill() {
        killed = true;
        closeStdout();
        closeStderr();
        finish(137);
      },
    };
    await expect(probePostgrestProcessIdentity(
      PID,
      { uid: UID, gid: GID },
      parentOperations(hangingChild),
      { timeoutMs: 5 },
    )).rejects.toThrow("timed out");
    expect(killed).toBe(true);

    const oversized = completedChild("x".repeat(POSTGREST_PROCESS_IDENTITY_STDOUT_LIMIT + 1));
    await expect(probePostgrestProcessIdentity(
      PID,
      { uid: UID, gid: GID },
      parentOperations(oversized),
    )).rejects.toThrow("output exceeded limit");

    await expect(probePostgrestProcessIdentity(
      PID,
      { uid: UID, gid: GID },
      parentOperations(completedChild("", SECRET_VALUE, 1)),
    )).rejects.not.toThrow(SECRET_VALUE);
  });

  test("bounds termination helper and child reap waits", async () => {
    const permissionDenied = new Error("operation not permitted") as NodeJS.ErrnoException;
    permissionDenied.code = "EPERM";
    const helperNeverExits: PostgrestProcessIdentityTerminationOperations = {
      spawn: () => ({ exited: new Promise<number>(() => {}) }),
    };
    await expect(terminatePostgrestIdentityProbe({
      pid: PID + 1,
      startId: "123456789",
      exited: Promise.resolve(137),
      kill: () => { throw permissionDenied; },
    }, { uid: UID, gid: GID }, "/usr/local/bin/supacloud", helperNeverExits)).rejects.toThrow(
      "termination helper timed out",
    );

    const childNeverExits: SpawnedPostgrestIdentityProbe = {
      pid: PID + 1,
      startId: "123456789",
      stdout: stream(""),
      stderr: stream(""),
      exited: new Promise<number>(() => {}),
      kill: () => {},
    };
    await expect(terminatePostgrestIdentityProbe(
      childNeverExits,
      { uid: UID, gid: GID },
      "/usr/local/bin/supacloud",
    )).rejects.toThrow("did not exit after termination");
  }, 5_000);
});
