import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  EMBEDDED_POSTGREST_LAUNCHER_SHA256,
  EMBEDDED_POSTGREST_LAUNCHER_SOURCE,
  activatePreparedPostgrestLauncher,
  cleanupPostgrestLauncherBackup,
  preparePostgrestLauncherActivation,
  readPostgrestLauncherPreflight,
  restorePostgrestLauncher,
  stageEmbeddedPostgrestLauncher,
  verifyInstalledPostgrestLauncher,
} from "../../src/embedded-postgrest-launcher";
import { upgradeRecoveryPaths } from "../../src/upgrade";

const owner = {
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
};

function launcherFixture(previous?: string) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-postgrest-launcher-")));
  const target = join(directory, "postgrest-launcher");
  if (previous !== undefined) {
    writeFileSync(target, previous, { mode: 0o755 });
    chmodSync(target, 0o755);
  }
  return { directory, target };
}

describe("embedded PostgREST launcher", () => {
  test("embeds the exact canonical launcher bytes and digest", () => {
    const sourcePath = join(import.meta.dir, "../../../../scripts/lib/postgrest_launcher.sh");
    const source = readFileSync(sourcePath, "utf8");
    expect(EMBEDDED_POSTGREST_LAUNCHER_SOURCE).toBe(source);
    expect(EMBEDDED_POSTGREST_LAUNCHER_SHA256).toBe(
      createHash("sha256").update(Buffer.from(source, "utf8")).digest("hex"),
    );
  });

  test("installs into a previously absent target and removes only that target on rollback", () => {
    const { directory, target } = launcherFixture();
    try {
      const preflight = readPostgrestLauncherPreflight(target, owner);
      expect(preflight).toBeNull();
      const staged = stageEmbeddedPostgrestLauncher(target, "absent", owner);
      const activation = activatePreparedPostgrestLauncher(preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "absent",
        owner,
        expectedPrevious: preflight,
      }));

      expect(activation.previous).toBeNull();
      expect(activation.backupReady).toBe(false);
      expect(verifyInstalledPostgrestLauncher(target, owner).sha256)
        .toBe(EMBEDDED_POSTGREST_LAUNCHER_SHA256);

      restorePostgrestLauncher(activation, owner);
      expect(readPostgrestLauncherPreflight(target, owner)).toBeNull();
      expect(activation.activated).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("replaces an existing launcher and restores its frozen bytes and mode", () => {
    const previousContent = "#!/bin/sh\nprintf old-launcher\\n\n";
    const { directory, target } = launcherFixture(previousContent);
    try {
      const preflight = readPostgrestLauncherPreflight(target, owner);
      expect(preflight).not.toBeNull();
      const staged = stageEmbeddedPostgrestLauncher(target, "replacement", owner);
      const activation = activatePreparedPostgrestLauncher(preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "replacement",
        owner,
        expectedPrevious: preflight,
      }));

      expect(readFileSync(target, "utf8")).toBe(EMBEDDED_POSTGREST_LAUNCHER_SOURCE);
      expect(lstatSync(activation.backupPath).nlink).toBe(1);
      restorePostgrestLauncher(activation, owner);
      expect(readFileSync(target, "utf8")).toBe(previousContent);
      expect(lstatSync(target).mode & 0o7777).toBe(0o755);

      cleanupPostgrestLauncherBackup(activation, owner);
      expect(activation.backupReady).toBe(false);
      expect(() => lstatSync(activation.backupPath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("fails closed on symbolic links, hard links, unsafe mode, and preflight drift", () => {
    const { directory, target } = launcherFixture("#!/bin/sh\nexit 0\n");
    try {
      const symbolic = join(directory, "symbolic");
      symlinkSync(target, symbolic);
      expect(() => readPostgrestLauncherPreflight(symbolic, owner)).toThrow("direct regular file");

      const hard = join(directory, "hard");
      linkSync(target, hard);
      expect(() => readPostgrestLauncherPreflight(target, owner)).toThrow("one link");
      rmSync(hard);

      chmodSync(target, 0o700);
      expect(() => readPostgrestLauncherPreflight(target, owner)).toThrow("mode must be exactly 0755");
      chmodSync(target, 0o755);

      const preflight = readPostgrestLauncherPreflight(target, owner);
      const staged = stageEmbeddedPostgrestLauncher(target, "drift", owner);
      writeFileSync(target, "#!/bin/sh\nprintf concurrent-change\\n\n", { mode: 0o755 });
      chmodSync(target, 0o755);
      expect(() => preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "drift",
        owner,
        expectedPrevious: preflight,
      })).toThrow("changed after upgrade preflight");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("never removes staging or backup paths that it failed to reserve", () => {
    const { directory, target } = launcherFixture("#!/bin/sh\nexit 0\n");
    const stagedCollision = `${target}.new-collision`;
    const backupCollision = `${target}.bak-backup-collision`;
    try {
      writeFileSync(stagedCollision, "foreign staged evidence", { mode: 0o600 });
      expect(() => stageEmbeddedPostgrestLauncher(target, "collision", owner)).toThrow();
      expect(readFileSync(stagedCollision, "utf8")).toBe("foreign staged evidence");

      const preflight = readPostgrestLauncherPreflight(target, owner);
      const staged = stageEmbeddedPostgrestLauncher(target, "backup-stage", owner);
      writeFileSync(backupCollision, "foreign backup evidence", { mode: 0o600 });
      expect(() => preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "backup-collision",
        owner,
        expectedPrevious: preflight,
      })).toThrow();
      expect(readFileSync(backupCollision, "utf8")).toBe("foreign backup evidence");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restores an absent target after a post-rename failure", () => {
    const { directory, target } = launcherFixture();
    try {
      const staged = stageEmbeddedPostgrestLauncher(target, "post-rename", owner);
      const prepared = preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "post-rename",
        owner,
        expectedPrevious: null,
      });

      expect(() => activatePreparedPostgrestLauncher(prepared, {
        syncDirectory: () => { throw new Error("directory fsync failed"); },
        verifyInstalled: () => { throw new Error("must not verify after fsync failure"); },
        restore: restorePostgrestLauncher,
      })).toThrow("directory fsync failed");
      expect(readPostgrestLauncherPreflight(target, owner)).toBeNull();
      expect(prepared.state.activated).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("aggregates activation and rollback failures while retaining recovery evidence", () => {
    const previousContent = "#!/bin/sh\nprintf previous\\n\n";
    const { directory, target } = launcherFixture(previousContent);
    try {
      const preflight = readPostgrestLauncherPreflight(target, owner);
      const staged = stageEmbeddedPostgrestLauncher(target, "aggregate", owner);
      const prepared = preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "aggregate",
        owner,
        expectedPrevious: preflight,
      });

      let failure: unknown;
      try {
        activatePreparedPostgrestLauncher(prepared, {
          syncDirectory: () => { throw new Error("post-rename failure"); },
          verifyInstalled: () => { throw new Error("must not verify after fsync failure"); },
          restore: () => { throw new Error("rollback failure"); },
        });
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(prepared.state.activated).toBe(true);
      expect(readFileSync(prepared.state.backupPath, "utf8")).toBe(previousContent);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses rollback after activated-target identity drift", () => {
    const { directory, target } = launcherFixture();
    try {
      const staged = stageEmbeddedPostgrestLauncher(target, "rollback-drift", owner);
      const activation = activatePreparedPostgrestLauncher(preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "rollback-drift",
        owner,
        expectedPrevious: null,
      }));
      const replacement = join(directory, "replacement");
      writeFileSync(replacement, EMBEDDED_POSTGREST_LAUNCHER_SOURCE, { mode: 0o755 });
      chmodSync(replacement, 0o755);
      renameSync(replacement, target);

      expect(() => restorePostgrestLauncher(activation, owner)).toThrow("changed before rollback");
      expect(activation.activated).toBe(true);
      expect(upgradeRecoveryPaths({ activation: { postgrestLauncher: activation } })).toContain(target);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains the canonical recovery path when absent-target removal is not durable", () => {
    const { directory, target } = launcherFixture();
    try {
      const staged = stageEmbeddedPostgrestLauncher(target, "rollback-fsync", owner);
      const activation = activatePreparedPostgrestLauncher(preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "rollback-fsync",
        owner,
        expectedPrevious: null,
      }));

      rmSync(target);
      expect(activation.activated).toBe(true);
      expect(readPostgrestLauncherPreflight(target, owner)).toBeNull();
      expect(upgradeRecoveryPaths({ activation: { postgrestLauncher: activation } })).toContain(target);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("retains a dangling canonical recovery target after identity drift", () => {
    const { directory, target } = launcherFixture();
    try {
      const staged = stageEmbeddedPostgrestLauncher(target, "dangling-drift", owner);
      const activation = activatePreparedPostgrestLauncher(preparePostgrestLauncherActivation({
        staged,
        targetPath: target,
        runId: "dangling-drift",
        owner,
        expectedPrevious: null,
      }));

      rmSync(target);
      symlinkSync(join(directory, "missing-launcher"), target);
      expect(() => restorePostgrestLauncher(activation, owner)).toThrow("direct regular file");
      expect(upgradeRecoveryPaths({ activation: { postgrestLauncher: activation } })).toContain(target);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
