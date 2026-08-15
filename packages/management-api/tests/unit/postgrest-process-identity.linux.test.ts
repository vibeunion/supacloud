import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probePostgrestProcessIdentity,
  terminatePostgrestIdentityProbe,
  type PostgrestProcessIdentityParentOperations,
} from "../../src/services/postgrest-process-identity";

const SETPRIV_PATH = "/usr/bin/setpriv";
const TENANT_UID = 981;
const TENANT_GID = 981;
const SECRET_VALUE = "same-uid-smoke-secret-value";

function capabilityMask(label: "CapEff" | "CapPrm" | "CapBnd"): bigint | null {
  if (process.platform !== "linux") return null;
  const status = readFileSync("/proc/self/status", "utf8");
  const match = status.match(new RegExp(`^${label}:\\s*([a-fA-F0-9]+)$`, "m"));
  return match ? BigInt(`0x${match[1]}`) : null;
}

async function processStartId(pid: number): Promise<string> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) throw new Error("Invalid Linux process stat");
  const startId = stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
  if (!startId || !/^\d+$/.test(startId)) throw new Error("Invalid Linux process start identity");
  return startId;
}

const managementCapabilityMask = 0xcbn;
const canRunLinuxPrivilegeSmoke = process.platform === "linux"
  && process.getuid?.() === 0
  && existsSync(SETPRIV_PATH)
  && capabilityMask("CapEff") === managementCapabilityMask
  && capabilityMask("CapPrm") === managementCapabilityMask
  && capabilityMask("CapBnd") === managementCapabilityMask;
const linuxPrivilegeTest = canRunLinuxPrivilegeSmoke ? test : test.skip;

linuxPrivilegeTest("compiled probe reads a same-UID process without CAP_SYS_PTRACE", async () => {
  const packageRoot = join(import.meta.dir, "../..");
  const buildDirectory = await mkdtemp(join(tmpdir(), "supacloud-postgrest-identity-linux-"));
  const binaryPath = join(buildDirectory, "supacloud");
  await chmod(buildDirectory, 0o755);
  let target: ReturnType<typeof Bun.spawn> | undefined;
  let targetStartId: string | undefined;
  try {
    const build = Bun.spawn({
      cmd: ["bun", "build", "src/standalone.ts", "--compile", `--outfile=${binaryPath}`],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildExit, buildStderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
      new Response(build.stdout).text(),
    ]);
    expect(buildExit, buildStderr).toBe(0);
    await chmod(binaryPath, 0o755);

    target = Bun.spawn({
      cmd: [
        SETPRIV_PATH,
        "--reuid",
        String(TENANT_UID),
        "--regid",
        String(TENANT_GID),
        "--clear-groups",
        "--",
        "/usr/bin/env",
        "-i",
        `POSTGREST_SMOKE_SECRET=${SECRET_VALUE}`,
        "/bin/sleep",
        "30",
      ],
      cwd: "/",
      env: { LANG: "C", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const tenantProcess = target;
    const targetPid = tenantProcess.pid;
    targetStartId = await processStartId(targetPid);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const metadata = await lstat(`/proc/${targetPid}`);
        const commandLine = await readFile(`/proc/${targetPid}/cmdline`, "utf8");
        if (metadata.uid === TENANT_UID
          && metadata.gid === TENANT_GID
          && commandLine.startsWith("/bin/sleep\0")) {
          ready = true;
          break;
        }
      } catch {
        // The bounded poll below handles the short setpriv -> sleep exec transition.
      }
      await Bun.sleep(10);
    }
    expect(ready).toBe(true);
    expect(capabilityMask("CapEff")).toBe(managementCapabilityMask);
    expect(capabilityMask("CapPrm")).toBe(managementCapabilityMask);
    expect(capabilityMask("CapBnd")).toBe(managementCapabilityMask);
    expect((managementCapabilityMask & (1n << 19n))).toBe(0n);
    expect((await readFile(`/proc/${targetPid}/cmdline`)).byteLength).toBeGreaterThan(0);
    await expect(readlink(`/proc/${targetPid}/exe`)).rejects.toBeDefined();
    await expect(readFile(`/proc/${targetPid}/environ`)).rejects.toBeDefined();

    let capturedStdout: Promise<string> | undefined;
    let capturedStderr: Promise<string> | undefined;
    const operations: PostgrestProcessIdentityParentOperations = {
      async processMetadata(pid) {
        const metadata = await lstat(`/proc/${pid}`);
        return {
          uid: metadata.uid,
          gid: metadata.gid,
          dev: metadata.dev,
          ino: metadata.ino,
          isDirectory: metadata.isDirectory(),
        };
      },
      async executablePath() {
        return binaryPath;
      },
      async spawn(command, options) {
        const child = Bun.spawn({
          cmd: command,
          cwd: options.cwd,
          env: options.environment,
          stdin: options.stdin,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [probeStdout, reviewStdout] = child.stdout.tee();
        const [probeStderr, reviewStderr] = child.stderr.tee();
        capturedStdout = new Response(reviewStdout).text();
        capturedStderr = new Response(reviewStderr).text();
        return {
          pid: child.pid,
          startId: await processStartId(child.pid),
          stdout: probeStdout,
          stderr: probeStderr,
          exited: child.exited,
          kill: (signal) => { child.kill(signal); },
        };
      },
    };
    const identity = await probePostgrestProcessIdentity(
      targetPid,
      { uid: TENANT_UID, gid: TENANT_GID },
      operations,
    );
    expect(identity.executable.endsWith("/sleep")).toBe(true);
    expect(identity.environmentNames).toEqual(["POSTGREST_SMOKE_SECRET"]);
    expect(JSON.stringify(identity)).not.toContain(SECRET_VALUE);
    expect(await capturedStdout).not.toContain(SECRET_VALUE);
    expect(await capturedStderr).not.toContain(SECRET_VALUE);
    expect(() => tenantProcess.kill("SIGKILL")).toThrow();
  } finally {
    try {
      if (target && targetStartId) {
        const tenantTarget = target;
        await terminatePostgrestIdentityProbe({
          pid: tenantTarget.pid,
          startId: targetStartId,
          exited: tenantTarget.exited,
          kill: (signal) => { tenantTarget.kill(signal); },
        }, { uid: TENANT_UID, gid: TENANT_GID }, binaryPath);
      }
    } finally {
      await rm(buildDirectory, { recursive: true, force: true });
    }
  }
}, 40_000);
