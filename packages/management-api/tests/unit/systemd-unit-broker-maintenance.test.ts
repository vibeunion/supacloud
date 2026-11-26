import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE,
  verifyInstalledSystemdUnitBroker,
} from "../../src/embedded-systemd-unit-broker";
import {
  cleanupFailedSystemdUnitBrokerJobs,
  ensureSystemdUnitBrokerForStartup,
} from "../../src/services/systemd-unit-broker-maintenance";

const owner = {
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
};

function brokerFixture(source = EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE, mode = 0o755) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-systemd-unit-maintenance-")));
  const target = join(directory, "systemd-unit");
  writeFileSync(target, source, { mode });
  chmodSync(target, mode);
  return { directory, target };
}

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (message: string) => lines.push(`INFO ${message}`),
      warn: (message: string) => lines.push(`WARN ${message}`),
    },
  };
}

describe("systemd-unit broker startup maintenance", () => {
  test("keeps a verified helper untouched", () => {
    const { directory, target } = brokerFixture();
    const before = lstatSync(target);
    try {
      const result = ensureSystemdUnitBrokerForStartup({
        targetPath: target,
        owner,
        getUid: () => 0,
      });
      expect(result.status).toBe("verified");
      expect(lstatSync(target).ino).toBe(before.ino);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("repairs a stale helper from the embedded release artifact", () => {
    const { directory, target } = brokerFixture("#!/bin/sh\nprintf stale\\n\n", 0o644);
    try {
      expect(lstatSync(target).mode & 0o777).toBe(0o644);
      const result = ensureSystemdUnitBrokerForStartup({
        targetPath: target,
        owner,
        getUid: () => 0,
      });
      expect(result.status).toBe("repaired");
      expect(readFileSync(target, "utf8")).toBe(EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE);
      expect(lstatSync(target).mode & 0o777).toBe(0o755);
      expect(verifyInstalledSystemdUnitBroker(target, owner).sha256).toBe(
        createHash("sha256").update(Buffer.from(EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE, "utf8")).digest("hex"),
      );    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("skips automatic repair without root and reports why", () => {
    const { directory, target } = brokerFixture("#!/bin/sh\nprintf stale\\n\n", 0o644);
    const logs = recordingLogger();
    try {
      const result = ensureSystemdUnitBrokerForStartup({
        targetPath: target,
        owner,
        getUid: () => 1000,
        logger: logs.logger,
      });
      expect(result.status).toBe("skipped");
      expect(result.status === "skipped" ? result.reason : "").toContain("requires root");
      expect(readFileSync(target, "utf8")).toContain("stale");
      expect(logs.lines.some((line) => line.startsWith("WARN"))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("clears only failed systemd-unit broker jobs", async () => {
    const calls: string[][] = [];
    const logs = recordingLogger();
    const units = [
      "supacloud-systemd-unit@11111111-1111-4111-8111-111111111111.service",
      "supacloud-systemd-unit@22222222-2222-4222-8222-222222222222.service",
    ];
    const runSystemctl = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "list-units") {
        return {
          exitCode: 0,
          stdout: [
            ...units.map((unit) => `${unit} loaded failed failed Install a unit`),
            "other.service loaded failed failed Unrelated",
          ].join("\n"),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const cleaned = await cleanupFailedSystemdUnitBrokerJobs({ logger: logs.logger, runSystemctl });
    expect(cleaned).toEqual([...units].sort());
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["reset-failed", ...[...units].sort()]);
    expect(logs.lines).toContain("WARN [Bootstrap] Clearing stale failed systemd-unit broker jobs");
  });

  test("does not reset anything when no failed broker job exists", async () => {
    const calls: string[][] = [];
    const runSystemctl = async (args: string[]) => {
      calls.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const cleaned = await cleanupFailedSystemdUnitBrokerJobs({ runSystemctl });
    expect(cleaned).toEqual([]);
    expect(calls).toEqual([[
      "list-units",
      "--failed",
      "--plain",
      "--no-legend",
      "supacloud-systemd-unit@*",
    ]]);
  });
});