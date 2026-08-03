import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "../../..", "..");
const temporaryDirectories: string[] = [];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Management pre-start recovery sandbox", () => {
  test("does not invoke a container runtime from the mount-filtered service", () => {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-pre-start-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "container-runtime-called");

    for (const runtime of ["podman", "docker"]) {
      writeExecutable(join(directory, runtime), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${marker}"\nexit 99\n`);
    }
    writeExecutable(join(directory, "psql"), "#!/usr/bin/env bash\nprintf 'search_path=auth, public\\n'\n");
    writeExecutable(join(directory, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");

    const run = Bun.spawnSync(["bash", join(repoRoot, "scripts/pre_start_recovery.sh")], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH || ""}`,
        PGDATA: join(directory, "missing-pgdata"),
        EDGE_RUNTIME_MODE: "external",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const preStart = readRepoFile("scripts/pre_start_recovery.sh");
    expect(preStart).not.toContain("podman");
    expect(preStart).not.toContain("docker");
    expect(preStart).not.toContain("ensure_service_containers_running");
  });

  test("does not terminate listeners while recovering the management service", () => {
    const preStart = readRepoFile("scripts/pre_start_recovery.sh");

    expect(preStart).not.toContain("kill_edge_runtime_zombies");
    expect(preStart).not.toContain("lsof -iTCP");
    expect(preStart).not.toContain("kill -9");
  });

  test("leaves postmaster.pid untouched when process liveness is ambiguous", () => {
    const directory = mkdtempSync(join(tmpdir(), "supacloud-postmaster-pid-"));
    temporaryDirectories.push(directory);
    const pgData = join(directory, "pgdata");
    const pidFile = join(pgData, "postmaster.pid");
    const psMarker = join(directory, "ps-called");

    mkdirSync(pgData, { recursive: true });
    writeFileSync(pidFile, "424242\n");
    writeExecutable(
      join(directory, "ps"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${psMarker}"\nexit 1\n`,
    );
    writeExecutable(join(directory, "psql"), "#!/usr/bin/env bash\nprintf 'search_path=auth, public\\n'\n");
    writeExecutable(join(directory, "systemctl"), "#!/usr/bin/env bash\nexit 0\n");

    const run = Bun.spawnSync(["bash", join(repoRoot, "scripts/pre_start_recovery.sh")], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH || ""}`,
        PGDATA: pgData,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(existsSync(psMarker)).toBe(true);
    expect(readFileSync(pidFile, "utf8")).toBe("424242\n");
    expect(run.stdout.toString()).toContain("leaving");
    expect(run.stdout.toString()).toContain("untouched");

    const preStart = readRepoFile("scripts/pre_start_recovery.sh");
    expect(preStart).not.toContain("kill -0");
    expect(preStart).not.toContain('rm -f "$pid_file"');
  });

  test("keeps container ownership outside the management sandbox", () => {
    const managementUnit = readRepoFile("infrastructure/systemd/supacloud.service");
    const realtimeUnit = readRepoFile("infrastructure/systemd/supacloud-realtime.service");
    const installer = readRepoFile("install.sh");
    const imaginarySection = installer.slice(
      installer.indexOf("# --- 1. Deploy Imaginary"),
      installer.indexOf("# --- 2. Deploy Supabase Realtime"),
    );

    expect(managementUnit).toContain("SystemCallFilter=~@mount");
    expect(managementUnit).toContain("ExecStartPre=/opt/supacloud/scripts/pre_start_recovery.sh");
    expect(managementUnit).not.toContain("ExecStartPre=/usr/bin/podman");
    expect(realtimeUnit).toContain("ExecStart=/usr/bin/podman run");
    expect(realtimeUnit).not.toContain("SystemCallFilter=");
    expect(imaginarySection).toContain("--restart=always");
  });
});
