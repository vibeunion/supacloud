import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LocalLogCollector,
  journalctlArgs,
  parseJournalEvent,
  projectLogFields,
  redactLogMessage,
} from "../../src/workers/local-log-collector.worker";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("LocalLogCollector", () => {
  test("reads only the allow-listed systemd units and resumes from its cursor", () => {
    const fresh = journalctlArgs();
    const resumed = journalctlArgs("s=cursor-1");

    expect(fresh).toContain("--since=15 minutes ago");
    expect(fresh).toContain("supacloud-gotrue@*.service");
    expect(fresh).toContain("supacloud-pgrst@*.service");
    expect(resumed).toContain("--after-cursor=s=cursor-1");
    expect(resumed).not.toContain("--since=15 minutes ago");
  });

  test("assigns tenant ownership and preserves journald microsecond timestamps", () => {
    const parsed = parseJournalEvent({
      __CURSOR: "s=cursor-1",
      __REALTIME_TIMESTAMP: "1785200523000000",
      _SYSTEMD_UNIT: "supacloud-pgrst@proj_1.service",
      MESSAGE: "request failed",
      PRIORITY: "3",
    });

    expect(parsed).toEqual({
      cursor: "s=cursor-1",
      event: expect.objectContaining({
        timestamp: "2026-07-28T01:02:03.000Z",
        message: "request failed",
        projectRef: "proj_1",
        service: "postgrest",
        severity: "error",
        unit: "supacloud-pgrst@proj_1.service",
      }),
    });
    expect(projectLogFields("supacloud-edge-runtime.service")).toEqual({ service: "functions-runtime" });
  });

  test("redacts credentials before they can reach persistent storage", () => {
    const message = redactLogMessage(
      "Authorization: Bearer secret Cookie=session=secret postgres://user:password@db/app access_token=secret",
    );

    expect(message).not.toContain("secret");
    expect(message).not.toContain("password@db");
    expect(message).toContain("Authorization=[REDACTED]");
    expect(redactLogMessage("access_token=secret")).toBe("access_token=[REDACTED]");
    expect(redactLogMessage("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signaturevalue")).not.toContain("eyJhbGci");
  });

  test("collects project function logs when journald is disabled in Compose", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "supacloud-compose-logs-"));
    temporaryDirectories.push(root);
    const functionsDirectory = path.join(root, "functions");
    const logDirectory = path.join(functionsDirectory, "project_1", ".logs");
    await mkdir(logDirectory, { recursive: true });
    await writeFile(path.join(logDirectory, "hello.log"), `${JSON.stringify({
      timestamp: "2026-07-28T01:02:03.000Z",
      message: "function completed",
      level: "info",
    })}\n`);
    const events: Array<Record<string, unknown>> = [];
    const collector = new LocalLogCollector({
      stateDirectory: path.join(root, "state"),
      functionsDirectory,
      journalEnabled: false,
      write: async (batch) => { events.push(...batch); },
    });

    await collector.start();
    await Bun.sleep(50);
    collector.stop();

    expect(events).toEqual([expect.objectContaining({
      projectRef: "project_1",
      service: "functions",
      message: "function completed",
    })]);
  });
});
