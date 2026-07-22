import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createBackup, listBackups, restore } from "../../src/services/backup.service";

interface CommandOutcome {
  exitCode?: number | Promise<number>;
  startError?: Error;
  stdout?: string;
  stderr?: string;
}

const commandOutcomes: CommandOutcome[] = [];
const spawnedCommands: string[][] = [];
const spawnSpy = spyOn(Bun, "spawn").mockImplementation((command) => {
  const commandOutcome = commandOutcomes.shift();
  if (!commandOutcome) throw new Error("Unexpected pgBackRest command");
  if (commandOutcome.startError) throw commandOutcome.startError;
  spawnedCommands.push(command as string[]);
  return {
    exited: Promise.resolve(commandOutcome.exitCode ?? 0),
    stdout: new Blob([commandOutcome.stdout || ""]).stream(),
    stderr: new Blob([commandOutcome.stderr || ""]).stream(),
  } as never;
});

function inventory(backups: unknown[], statusCode = 0, stanza = "db-main") {
  const message = statusCode === 0 ? "ok" : statusCode === 2 ? "no valid backups" : "missing stanza path";
  const status = { code: statusCode, message };
  return JSON.stringify([{
    name: stanza,
    backup: backups,
    status,
    repo: [{ key: 1, status }],
  }]);
}

function fullBackup(label = "20260722-120000F", error = false) {
  return {
    label,
    type: "full",
    timestamp: { start: 1_784_000_000, stop: 1_784_000_030 },
    info: { size: 2048, repository: { size: 1024 } },
    error,
  };
}

describe("BackupService", () => {
  beforeEach(() => {
    commandOutcomes.length = 0;
    spawnedCommands.length = 0;
  });

  afterAll(() => spawnSpy.mockRestore());

  test("uses one cluster stanza and reports the requested tenant database", async () => {
    commandOutcomes.push({ exitCode: 0, stdout: inventory([fullBackup()]) });
    const backups = await listBackups("supa_project_a");

    expect(spawnedCommands).toEqual([[
      "timeout", "--kill-after=30s", "5", "sudo", "-n", "-u", "postgres", "pgbackrest",
      "--stanza=db-main", "info", "--output=json",
    ]]);
    expect(backups).toEqual([{
      id: "20260722-120000F",
      type: "full",
      timestamp: { start: 1_784_000_000, stop: 1_784_000_030 },
      size: 2048,
      database: "supa_project_a",
    }]);
  });

  test("does not report success until a new completed backup record is readable", async () => {
    commandOutcomes.push(
      { exitCode: 0, stdout: inventory([], 2) },
      { exitCode: 0 },
      { exitCode: 0, stdout: inventory([fullBackup()]) },
    );

    await expect(createBackup("full")).resolves.toEqual({ message: "full backup completed" });
    expect(spawnedCommands.map((command) => command.at(-1))).toEqual(["--output=json", "backup", "--output=json"]);
    expect(spawnedCommands[1]).toContain("--type=full");
  });

  test("reports the effective full backup when pgBackRest promotes the first incremental backup", async () => {
    commandOutcomes.push(
      { exitCode: 0, stdout: inventory([], 2) },
      { exitCode: 0 },
      { exitCode: 0, stdout: inventory([fullBackup()]) },
    );

    await expect(createBackup("incr")).resolves.toEqual({ message: "full backup completed" });
  });

  test("fails closed when pgBackRest reports an unhealthy stanza in successful JSON output", async () => {
    commandOutcomes.push({ exitCode: 0, stdout: inventory([], 1) });

    await expect(listBackups("supa_project_a")).rejects.toThrow("pgBackRest backup inventory is unavailable");
  });

  test("treats the official no-valid-backups status as an empty readable inventory", async () => {
    commandOutcomes.push({ exitCode: 0, stdout: inventory([], 2) });

    await expect(listBackups("supa_project_a")).resolves.toEqual([]);
  });

  test("fails closed when a pgBackRest repository is unhealthy", async () => {
    commandOutcomes.push({
      exitCode: 0,
      stdout: JSON.stringify([{
        name: "db-main",
        backup: [],
        status: { code: 0, message: "mixed" },
        repo: [{ key: 1, status: { code: 3, message: "missing stanza data" } }],
      }]),
    });

    await expect(listBackups("supa_project_a")).rejects.toThrow("pgBackRest backup inventory is unavailable");
  });

  test("fails closed when the pgBackRest repository status array is missing", async () => {
    commandOutcomes.push({
      exitCode: 0,
      stdout: JSON.stringify([{
        name: "db-main",
        backup: [fullBackup()],
        status: { code: 0, message: "ok" },
      }]),
    });

    await expect(listBackups("supa_project_a")).rejects.toThrow("pgBackRest backup inventory is unavailable");
  });

  test("does not expose a backup record that pgBackRest marked as erroneous", async () => {
    commandOutcomes.push({ exitCode: 0, stdout: inventory([fullBackup("20260722-120000F", true)]) });

    await expect(listBackups("supa_project_a")).rejects.toThrow("Invalid pgBackRest backup inventory");
  });

  test("fails closed when pgBackRest cannot produce an inventory or backup", async () => {
    commandOutcomes.push({ exitCode: 1, stderr: "not available" });
    await expect(listBackups("supa_project_a")).rejects.toThrow("pgBackRest backup inventory failed");

    commandOutcomes.push(
      { exitCode: 0, stdout: inventory([], 2) },
      { exitCode: 1 },
    );
    await expect(createBackup("full")).rejects.toThrow("pgBackRest backup failed");
  });

  test("fails closed when the pgBackRest command cannot start", async () => {
    commandOutcomes.push({ startError: new Error("timeout is not installed") });
    await expect(listBackups("supa_project_a")).rejects.toThrow("pgBackRest command is unavailable");
  });

  test("fails closed when the completed backup does not appear in inventory", async () => {
    commandOutcomes.push(
      { exitCode: 0, stdout: inventory([], 2) },
      { exitCode: 0 },
      { exitCode: 0, stdout: inventory([], 2) },
    );

    await expect(createBackup("full")).rejects.toThrow("pgBackRest backup record is unavailable");
  });

  test("waits for PITR execution and fails closed when the cluster restore command fails", async () => {
    commandOutcomes.push({ exitCode: 1, stderr: "restore failed" });

    await expect(restore({ target: "2026-07-22T01:30:00Z" })).rejects.toThrow("PITR restore failed");
    expect(spawnedCommands.at(-1)).toEqual([
      "timeout", "--kill-after=30s", "1800", "sudo", "-n", "-u", "postgres", "pig", "pitr",
      "-s", "db-main", "-t", "2026-07-22T01:30:00Z", "-y",
    ]);
  });

  test("reports PITR success only after the cluster restore command exits successfully", async () => {
    commandOutcomes.push({ exitCode: 0 });

    await expect(restore({ target: "2026-07-22T01:30:00Z" })).resolves.toEqual({
      message: "Point-in-time recovery (PITR) completed, target: 2026-07-22T01:30:00Z",
    });
  });

  test("fails closed when PITR times out or cannot start", async () => {
    commandOutcomes.push({ exitCode: 124 });
    await expect(restore({ target: "2026-07-22T01:30:00Z" })).rejects.toThrow("PITR restore timed out");

    commandOutcomes.push({ startError: new Error("pig is not installed") });
    await expect(restore({ target: "2026-07-22T01:30:00Z" })).rejects.toThrow("PITR restore command is unavailable");
  });

  test("rejects concurrent PITR restores and releases the guard after completion", async () => {
    let finishRestore!: (exitCode: number) => void;
    commandOutcomes.push({
      exitCode: new Promise<number>((resolve) => {
        finishRestore = resolve;
      }),
    });

    const activeRestore = restore({ target: "2026-07-22T01:30:00Z" });
    await expect(restore({ target: "2026-07-22T01:31:00Z" })).rejects.toThrow("already in progress");
    finishRestore(0);
    await expect(activeRestore).resolves.toMatchObject({ message: expect.stringContaining("completed") });

    commandOutcomes.push({ exitCode: 0 });
    await expect(restore({ target: "2026-07-22T01:32:00Z" })).resolves.toMatchObject({
      message: expect.stringContaining("completed"),
    });
  });

  test("builds non-interactive backup and PITR commands from the configured cluster stanza", async () => {
    const previousEnvironment = {
      stanza: process.env.SUPACLOUD_PGBACKREST_STANZA,
      user: process.env.SUPACLOUD_PGBACKREST_USER,
      binary: process.env.SUPACLOUD_PGBACKREST_BIN,
    };
    process.env.SUPACLOUD_PGBACKREST_STANZA = "cluster-main";
    process.env.SUPACLOUD_PGBACKREST_USER = "pgbackrest";
    process.env.SUPACLOUD_PGBACKREST_BIN = "/usr/bin/pgbackrest";
    try {
      commandOutcomes.push({ exitCode: 0, stdout: inventory([], 0, "cluster-main") });
      await listBackups("supa_project_a");
      expect(spawnedCommands).toEqual([[
        "timeout", "--kill-after=30s", "5", "sudo", "-n", "-u", "pgbackrest", "/usr/bin/pgbackrest",
        "--stanza=cluster-main", "info", "--output=json",
      ]]);

      commandOutcomes.push({ exitCode: 0 });
      await restore({ target: "2026-07-22T01:30:00Z" });
      expect(spawnedCommands[1]).toEqual([
        "timeout", "--kill-after=30s", "1800", "sudo", "-n", "-u", "postgres", "pig", "pitr",
        "-s", "cluster-main", "-t", "2026-07-22T01:30:00Z", "-y",
      ]);
    } finally {
      if (previousEnvironment.stanza === undefined) delete process.env.SUPACLOUD_PGBACKREST_STANZA;
      else process.env.SUPACLOUD_PGBACKREST_STANZA = previousEnvironment.stanza;
      if (previousEnvironment.user === undefined) delete process.env.SUPACLOUD_PGBACKREST_USER;
      else process.env.SUPACLOUD_PGBACKREST_USER = previousEnvironment.user;
      if (previousEnvironment.binary === undefined) delete process.env.SUPACLOUD_PGBACKREST_BIN;
      else process.env.SUPACLOUD_PGBACKREST_BIN = previousEnvironment.binary;
    }
  });
});
