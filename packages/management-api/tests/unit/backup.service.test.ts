import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createBackup, listBackups } from "../../src/services/backup.service";

interface CommandOutcome {
  exitCode?: number;
  startError?: Error;
  stdout?: string;
}

const commandOutcomes: CommandOutcome[] = [];
const spawnedCommands: string[][] = [];
const spawnSpy = spyOn(Bun, "spawn").mockImplementation((command) => {
  const commandOutcome = commandOutcomes.shift();
  if (!commandOutcome) throw new Error("Unexpected pgBackRest command");
  if (commandOutcome.startError) throw commandOutcome.startError;
  spawnedCommands.push(command as string[]);
  return {
    exited: Promise.resolve(commandOutcome.exitCode || 0),
    stdout: new Blob([commandOutcome.stdout || ""]).stream(),
    stderr: new Blob([]).stream(),
  } as never;
});

function inventory(backups: unknown[]) {
  return JSON.stringify([{ name: "db-main", backup: backups }]);
}

function fullBackup(label = "20260722-120000F") {
  return {
    label,
    type: "full",
    timestamp: { start: 1_784_000_000, stop: 1_784_000_030 },
    info: { size: 2048, repository: { size: 1024 } },
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
      "timeout", "5", "sudo", "-n", "-u", "postgres", "pgbackrest",
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
      { exitCode: 0, stdout: inventory([]) },
      { exitCode: 0 },
      { exitCode: 0, stdout: inventory([fullBackup()]) },
    );

    await expect(createBackup("full")).resolves.toEqual({ message: "full backup completed" });
    expect(spawnedCommands.map((command) => command.at(-1))).toEqual(["--output=json", "backup", "--output=json"]);
    expect(spawnedCommands[1]).toContain("--type=full");
  });

  test("fails closed when pgBackRest cannot produce an inventory or backup", async () => {
    commandOutcomes.push({ exitCode: 1, stderr: "not available" });
    await expect(listBackups("supa_project_a")).rejects.toThrow("pgBackRest backup inventory failed");

    commandOutcomes.push(
      { exitCode: 0, stdout: inventory([]) },
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
      { exitCode: 0, stdout: inventory([]) },
      { exitCode: 0 },
      { exitCode: 0, stdout: inventory([]) },
    );

    await expect(createBackup("full")).rejects.toThrow("pgBackRest backup record is unavailable");
  });

  test("builds a non-interactive command from the configured cluster stanza", async () => {
    const previousEnvironment = {
      stanza: process.env.SUPACLOUD_PGBACKREST_STANZA,
      user: process.env.SUPACLOUD_PGBACKREST_USER,
      binary: process.env.SUPACLOUD_PGBACKREST_BIN,
    };
    process.env.SUPACLOUD_PGBACKREST_STANZA = "cluster-main";
    process.env.SUPACLOUD_PGBACKREST_USER = "pgbackrest";
    process.env.SUPACLOUD_PGBACKREST_BIN = "/usr/bin/pgbackrest";
    try {
      commandOutcomes.push({ exitCode: 0, stdout: inventory([]) });
      await listBackups("supa_project_a");
      expect(spawnedCommands).toEqual([[
        "timeout", "5", "sudo", "-n", "-u", "pgbackrest", "/usr/bin/pgbackrest",
        "--stanza=cluster-main", "info", "--output=json",
      ]]);
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
