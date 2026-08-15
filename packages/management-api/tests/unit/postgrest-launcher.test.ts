import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "../../../..");
const launcher = join(repoRoot, "scripts/lib/postgrest_launcher.sh");
const projectRef = "abcdefghijklmnopqrst";
const generationDigest = "a".repeat(64);
const generationTarget = `${projectRef}_postgrest.d/${generationDigest}.conf`;

type LauncherFixture = {
  root: string;
  configRoot: string;
  generationDirectory: string;
  generationPath: string;
  pointerPath: string;
  binaryPath: string;
};

function createLauncherFixture(): LauncherFixture {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "supacloud-pgrst-launcher-")));
  const configRoot = join(root, "tenants");
  const generationDirectory = join(configRoot, `${projectRef}_postgrest.d`);
  const generationPath = join(configRoot, generationTarget);
  const pointerPath = join(configRoot, `${projectRef}_postgrest.current`);
  const binaryPath = join(root, "postgrest");
  mkdirSync(generationDirectory, { recursive: true });
  chmodSync(configRoot, 0o711);
  chmodSync(generationDirectory, 0o750);
  writeFileSync(generationPath, "# Managed by SupaCloud Management API.\nserver-port = 3100\n");
  chmodSync(generationPath, 0o440);
  writeFileSync(pointerPath, `${generationTarget}\n`);
  chmodSync(pointerPath, 0o440);
  writeFileSync(binaryPath, '#!/bin/sh\nprintf "ARG=%s\\n" "$@"\nenv | sort\n');
  chmodSync(binaryPath, 0o755);
  return { root, configRoot, generationDirectory, generationPath, pointerPath, binaryPath };
}

function invokeLauncher(fixture: LauncherFixture) {
  return spawnSync("bash", [launcher, projectRef, "+RTS", "-N1", "-RTS"], {
    encoding: "utf8",
    env: {
      ...process.env,
      SUPACLOUD_POSTGREST_BIN: fixture.binaryPath,
      SUPACLOUD_POSTGREST_BINARY_TRUST_ROOT: fixture.root,
      SUPACLOUD_POSTGREST_CONFIG_DIR: fixture.configRoot,
      SUPACLOUD_POSTGREST_CONFIG_TRUST_ROOT: fixture.root,
      SUPACLOUD_POSTGREST_CONTROL_UID: String(process.getuid?.() ?? 0),
      PGRST_DB_URI: "must-not-reach-postgrest",
      SUPABASE_SERVICE_ROLE_KEY: "must-not-reach-postgrest",
    },
  });
}

function setFixtureMode(path: string, mode: number): void {
  const octalMode = mode.toString(8);
  const chmod = spawnSync("/bin/chmod", [octalMode, path]);
  if (chmod.status !== 0) {
    throw new Error(`Cannot set launcher fixture mode ${octalMode}`);
  }
}

describe("PostgREST launcher", () => {
  test("executes the immutable generation with a cleared environment", () => {
    const fixture = createLauncherFixture();
    try {
      const launched = invokeLauncher(fixture);

      expect(launched.status).toBe(0);
      expect(launched.stdout).toContain(`ARG=${fixture.generationPath}`);
      expect(launched.stdout).toContain("ARG=+RTS\nARG=-N1\nARG=-RTS");
      expect(launched.stdout).not.toContain("PGRST_DB_URI");
      expect(launched.stdout).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test.each([
    ["pointer with extra data", (fixture: LauncherFixture) => {
      chmodSync(fixture.pointerPath, 0o640);
      writeFileSync(fixture.pointerPath, `${generationTarget}\nextra\n`);
      chmodSync(fixture.pointerPath, 0o440);
    }],
    ["writable generation", (fixture: LauncherFixture) => chmodSync(fixture.generationPath, 0o640)],
    ["setuid generation", (fixture: LauncherFixture) => setFixtureMode(fixture.generationPath, 0o4440)],
    ["setgid generation", (fixture: LauncherFixture) => setFixtureMode(fixture.generationPath, 0o2440)],
    ["sticky generation", (fixture: LauncherFixture) => setFixtureMode(fixture.generationPath, 0o1440)],
    ["hard-linked generation", (fixture: LauncherFixture) => {
      linkSync(fixture.generationPath, `${fixture.generationPath}.hardlink`);
    }],
    ["symlink generation", (fixture: LauncherFixture) => {
      const replacement = `${fixture.generationPath}.replacement`;
      writeFileSync(replacement, "server-port = 3100\n");
      chmodSync(replacement, 0o440);
      rmSync(fixture.generationPath);
      symlinkSync(replacement, fixture.generationPath);
    }],
    ["setuid generation directory", (fixture: LauncherFixture) => {
      setFixtureMode(fixture.generationDirectory, 0o4750);
    }],
    ["setgid generation directory", (fixture: LauncherFixture) => {
      setFixtureMode(fixture.generationDirectory, 0o2750);
    }],
    ["sticky generation directory", (fixture: LauncherFixture) => {
      setFixtureMode(fixture.generationDirectory, 0o1750);
    }],
    ["setuid PostgREST binary", (fixture: LauncherFixture) => {
      setFixtureMode(fixture.binaryPath, 0o4755);
    }],
    ["setgid PostgREST binary", (fixture: LauncherFixture) => {
      setFixtureMode(fixture.binaryPath, 0o2755);
    }],
    ["sticky PostgREST binary", (fixture: LauncherFixture) => {
      setFixtureMode(fixture.binaryPath, 0o1755);
    }],
    ["writable configuration root", (fixture: LauncherFixture) => chmodSync(fixture.configRoot, 0o733)],
  ])("rejects %s", (_label, mutate) => {
    const fixture = createLauncherFixture();
    try {
      mutate(fixture);
      const launched = invokeLauncher(fixture);

      expect(launched.status).not.toBe(0);
      expect(launched.stdout).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("supports an explicitly unverified legacy file only when no pointer exists", () => {
    const fixture = createLauncherFixture();
    const legacyPath = join(fixture.configRoot, `${projectRef}.conf`);
    try {
      rmSync(fixture.pointerPath);
      writeFileSync(legacyPath, "server-port = 3100\n");
      chmodSync(legacyPath, 0o600);

      const launched = invokeLauncher(fixture);

      expect(launched.status).toBe(0);
      expect(launched.stdout).toContain(`ARG=${legacyPath}`);

      writeFileSync(fixture.pointerPath, "../legacy.conf\n");
      chmodSync(fixture.pointerPath, 0o440);
      expect(invokeLauncher(fixture).status).not.toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe("PostgREST launcher installation", () => {
  test("installs and rolls back the canonical launcher path", () => {
    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");
    const runtime = readFileSync(join(repoRoot, "scripts/lib/tenant_runtime.sh"), "utf8");
    const service = readFileSync(
      join(repoRoot, "packages/management-api/src/services/tenant-runtime.service.ts"),
      "utf8",
    );
    const template = readFileSync(
      join(repoRoot, "packages/management-api/src/services/postgrest-systemd-template.ts"),
      "utf8",
    );
    const canonicalPath = "/usr/local/libexec/supacloud/postgrest-launcher";

    expect(installer).toContain(`local launcher_target="${canonicalPath}"`);
    expect(installer).toContain(`supacloud_capture_file_snapshot ${canonicalPath}`);
    expect(installer).toContain(`supacloud_restore_file_snapshot ${canonicalPath}`);
    expect(installer).toContain("install_postgrest_launcher || activation_status=$?");
    expect(runtime).toContain(`ExecStart=${canonicalPath} %i`);
    expect(template).toContain(`ExecStart=${canonicalPath} %i`);
    expect(service).toContain("renderPostgrestSystemdTemplate({");
    expect(`${service}\n${template}`).not.toContain("/usr/local/libexec/supacloud-postgrest-launcher");
  });
});
