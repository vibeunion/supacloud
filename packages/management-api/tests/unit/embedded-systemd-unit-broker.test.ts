import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256,
  EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE,
  activatePreparedSystemdUnitBroker,
  cleanupSystemdUnitBrokerBackup,
  prepareSystemdUnitBrokerActivation,
  readPrivilegedHelperIdentity,
  restoreSystemdUnitBroker,
  stageEmbeddedSystemdUnitBroker,
  verifyInstalledSystemdUnitBroker,
} from "../../src/embedded-systemd-unit-broker";

const owner = {
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
};

function helperFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-systemd-unit-helper-")));
  const target = join(directory, "systemd-unit");
  writeFileSync(target, "#!/bin/sh\nprintf old-helper\\n\n", { mode: 0o755 });
  chmodSync(target, 0o755);
  return { directory, target };
}

function activateSystemdUnitBroker(
  request: Parameters<typeof prepareSystemdUnitBrokerActivation>[0],
) {
  return activatePreparedSystemdUnitBroker(prepareSystemdUnitBrokerActivation(request));
}

describe("embedded privileged systemd-unit helper", () => {
  test("embeds the exact canonical shell helper bytes and digest", () => {
    const sourcePath = join(import.meta.dir, "../../../../scripts/lib/systemd_unit_broker.sh");
    const source = readFileSync(sourcePath, "utf8");
    expect(EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE).toBe(source);
    expect(EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256).toBe(
      createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"),
    );
  });

  test("delivers helper B from the target release and restores exact helper A", () => {
    const { directory, target } = helperFixture();
    try {
      const previous = readPrivilegedHelperIdentity(target, owner);
      const staged = stageEmbeddedSystemdUnitBroker(target, "stage", owner);
      expect(previous.sha256).not.toBe(EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256);
      expect(lstatSync(staged.path).mode & 0o777).toBe(0o755);
      expect(staged.sha256).toBe(EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256);

      const activation = activateSystemdUnitBroker({
        staged,
        targetPath: target,
        runId: "activate",
        owner,
      });
      expect(verifyInstalledSystemdUnitBroker(target, owner).sha256)
        .toBe(EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256);
      expect(readFileSync(target, "utf8")).toBe(EMBEDDED_SYSTEMD_UNIT_BROKER_SOURCE);
      expect(lstatSync(target).mode & 0o777).toBe(0o755);
      expect(lstatSync(activation.backupPath).nlink).toBe(1);

      restoreSystemdUnitBroker(activation, owner);
      const restored = readPrivilegedHelperIdentity(target, owner, previous.mode);
      expect(restored.sha256).toBe(previous.sha256);
      expect(restored.content).toEqual(previous.content);
      expect(restored.mode).toBe(previous.mode);

      cleanupSystemdUnitBrokerBackup(activation);
      expect(() => lstatSync(activation.backupPath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on missing, symbolic-link, hard-link, or staged digest drift", () => {
    const { directory, target } = helperFixture();
    try {
      expect(() => readPrivilegedHelperIdentity(join(directory, "missing"), owner)).toThrow("missing");

      const symbolic = join(directory, "symbolic");
      symlinkSync(target, symbolic);
      expect(() => readPrivilegedHelperIdentity(symbolic, owner)).toThrow("direct regular file");

      const hard = join(directory, "hard");
      linkSync(target, hard);
      expect(() => readPrivilegedHelperIdentity(target, owner)).toThrow("one link");
      rmSync(hard);

      const staged = stageEmbeddedSystemdUnitBroker(target, "drift", owner);
      writeFileSync(staged.path, "#!/bin/sh\nprintf tampered\\n\n", { mode: 0o755 });
      chmodSync(staged.path, 0o755);
      const previous = readFileSync(target);
      expect(() => activateSystemdUnitBroker({
        staged,
        targetPath: target,
        runId: "drift",
        owner,
      }))
        .toThrow("identity changed");
      expect(readFileSync(target)).toEqual(previous);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses activation when the helper changed after the frozen preflight", () => {
    const { directory, target } = helperFixture();
    try {
      const preflight = readPrivilegedHelperIdentity(target, owner);
      const staged = stageEmbeddedSystemdUnitBroker(target, "preflight-drift", owner);
      writeFileSync(target, "#!/bin/sh\nprintf concurrent-change\\n\n", { mode: 0o755 });
      chmodSync(target, 0o755);

      expect(() => activateSystemdUnitBroker({
        staged,
        targetPath: target,
        runId: "preflight-drift",
        owner,
        expectedPrevious: preflight,
      })).toThrow("changed after upgrade preflight");
      expect(readFileSync(target, "utf8")).toContain("concurrent-change");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails rollback closed when the frozen backup digest changes", () => {
    const { directory, target } = helperFixture();
    try {
      const staged = stageEmbeddedSystemdUnitBroker(target, "backup-drift", owner);
      const activation = activateSystemdUnitBroker({
        staged,
        targetPath: target,
        runId: "backup-drift",
        owner,
      });
      writeFileSync(activation.backupPath, "tampered backup", { mode: 0o755 });
      chmodSync(activation.backupPath, 0o755);

      expect(() => restoreSystemdUnitBroker(activation, owner)).toThrow("backup changed");
      expect(verifyInstalledSystemdUnitBroker(target, owner).sha256)
        .toBe(EMBEDDED_SYSTEMD_UNIT_BROKER_SHA256);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains recovery evidence when the activated target inode or mode drifts", () => {
    for (const drift of ["inode", "mode"] as const) {
      const { directory, target } = helperFixture();
      try {
        const staged = stageEmbeddedSystemdUnitBroker(target, `activated-${drift}`, owner);
        const prepared = prepareSystemdUnitBrokerActivation({
          staged,
          targetPath: target,
          runId: `activated-${drift}`,
          owner,
        });
        expect(prepared.state.backupReady).toBe(true);
        expect(lstatSync(prepared.state.backupPath).isFile()).toBe(true);
        const activation = activatePreparedSystemdUnitBroker(prepared);
        if (drift === "mode") {
          chmodSync(target, 0o700);
        } else {
          const replacement = join(directory, "replacement");
          copyFileSync(target, replacement);
          chmodSync(replacement, 0o755);
          renameSync(replacement, target);
        }

        expect(() => restoreSystemdUnitBroker(activation, owner)).toThrow();
        expect(lstatSync(activation.backupPath).isFile()).toBe(true);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  test("refuses rollback under an unexpected ownership contract and retains the backup", () => {
    const { directory, target } = helperFixture();
    try {
      const staged = stageEmbeddedSystemdUnitBroker(target, "owner-drift", owner);
      const activation = activateSystemdUnitBroker({
        staged,
        targetPath: target,
        runId: "owner-drift",
        owner,
      });
      expect(() => restoreSystemdUnitBroker(activation, {
        uid: owner.uid + 1,
        gid: owner.gid,
      })).toThrow("owned by uid");
      expect(lstatSync(activation.backupPath).isFile()).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
