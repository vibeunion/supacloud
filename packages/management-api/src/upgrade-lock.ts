import { spawnSync, type StdioOptions } from "node:child_process";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs";

export const SUPACLOUD_UPGRADE_LOCK_PATH = "/run/lock/supacloud-upgrade.lock";

const INHERITED_UPGRADE_LOCK_FD = 9;
const UPGRADE_LOCK_FD_ENV = "SUPACLOUD_UPGRADE_LOCK_FD";

export type SupaCloudUpgradeLock = {
    release: () => void;
};

export function buildUpgradeLockScript(lockPath: string): string {
    return [
        `UPGRADE_LOCK=${quoteShell(lockPath)}`,
        "test ! -L \"$UPGRADE_LOCK\" || { echo 'SupaCloud upgrade lock must not be a symlink' >&2; exit 1; }",
        "if [ ! -e \"$UPGRADE_LOCK\" ]; then (umask 077; : >> \"$UPGRADE_LOCK\"); fi",
        "test -f \"$UPGRADE_LOCK\" && test ! -L \"$UPGRADE_LOCK\" || { echo 'SupaCloud upgrade lock must be a regular file' >&2; exit 1; }",
        "test \"$(stat -c '%u:%g' \"$UPGRADE_LOCK\")\" = \"$(id -u):$(id -g)\" || { echo 'SupaCloud upgrade lock has an unexpected owner' >&2; exit 1; }",
        "LOCK_MODE=$(stat -c '%a' \"$UPGRADE_LOCK\")",
        "case \"$LOCK_MODE\" in [0-7]|[0-7][0-7]|[0-7][0-7][0-7]) ;; *) echo 'SupaCloud upgrade lock has special permission bits' >&2; exit 1 ;; esac",
        "(( (8#$LOCK_MODE & 0022) == 0 )) || { echo 'SupaCloud upgrade lock is group/other writable' >&2; exit 1; }",
        `exec ${INHERITED_UPGRADE_LOCK_FD}<>"$UPGRADE_LOCK"`,
        `flock -E 75 -n ${INHERITED_UPGRADE_LOCK_FD} || { echo 'Another SupaCloud upgrade is already running' >&2; exit 75; }`,
        `export ${UPGRADE_LOCK_FD_ENV}=${INHERITED_UPGRADE_LOCK_FD}`,
    ].join("\n");
}

function quoteShell(shellText: string): string {
    return `'${shellText.split("'").join("'\\''")}'`;
}

function expectedMissingDescriptor(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EBADF" || code === "ENOENT";
}

function inheritedUpgradeLockMatches(lockPath: string): boolean {
    if (process.env[UPGRADE_LOCK_FD_ENV] !== String(INHERITED_UPGRADE_LOCK_FD)) return false;
    try {
        const descriptorState = fstatSync(INHERITED_UPGRADE_LOCK_FD);
        const lockPathState = lstatSync(lockPath);
        return descriptorState.isFile() && lockPathState.isFile()
            && descriptorState.dev === lockPathState.dev
            && descriptorState.ino === lockPathState.ino;
    } catch (error: unknown) {
        if (expectedMissingDescriptor(error)) return false;
        throw error;
    }
}

function openUpgradeLockFile(lockPath: string): number {
    const descriptor = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        0o600,
    );
    try {
        const state = fstatSync(descriptor);
        if (!state.isFile()) throw new Error("SupaCloud upgrade lock is not a regular file");
        const effectiveUid = process.geteuid?.();
        if (effectiveUid !== undefined && state.uid !== effectiveUid) {
            throw new Error("SupaCloud upgrade lock is owned by another user");
        }
        fchmodSync(descriptor, 0o600);
        return descriptor;
    } catch (error: unknown) {
        closeSync(descriptor);
        throw error;
    }
}

function inheritedLockStdio(descriptor: number): StdioOptions {
    const stdio: Array<"ignore" | "pipe" | number> = Array.from(
        { length: descriptor + 1 },
        () => "ignore",
    );
    stdio[2] = "pipe";
    stdio[descriptor] = descriptor;
    return stdio;
}

function descriptorLockCommand(descriptor: number): {
    command: string;
    arguments: string[];
    busyStatus: number;
} {
    if (process.platform === "linux") {
        return { command: "flock", arguments: ["-E", "75", "-n", String(descriptor)], busyStatus: 75 };
    }
    if (process.platform === "darwin") {
        return {
            command: "/usr/bin/lockf",
            arguments: ["-s", "-t", "0", String(descriptor)],
            busyStatus: 75,
        };
    }
    throw new Error("SupaCloud upgrade locking is unsupported on this platform");
}

function acquireDescriptorLock(descriptor: number): void {
    const lockCommand = descriptorLockCommand(descriptor);
    const attempt = spawnSync(
        lockCommand.command,
        lockCommand.arguments,
        { stdio: inheritedLockStdio(descriptor) },
    );
    if (attempt.status === 0) return;
    if (attempt.status === lockCommand.busyStatus) {
        throw new Error("Another SupaCloud upgrade is already running");
    }
    const diagnostic = attempt.error?.message
        || attempt.stderr?.toString("utf8").trim()
        || `exit ${attempt.status ?? "unknown"}`;
    throw new Error(`Unable to acquire the SupaCloud upgrade lock: ${diagnostic.slice(-300)}`);
}

export function acquireSupaCloudUpgradeLock(lockPath: string): SupaCloudUpgradeLock {
    if (inheritedUpgradeLockMatches(lockPath)) {
        acquireDescriptorLock(INHERITED_UPGRADE_LOCK_FD);
        return { release: () => {} };
    }
    const descriptor = openUpgradeLockFile(lockPath);
    try {
        acquireDescriptorLock(descriptor);
    } catch (error: unknown) {
        closeSync(descriptor);
        throw error;
    }
    return { release: () => closeSync(descriptor) };
}
