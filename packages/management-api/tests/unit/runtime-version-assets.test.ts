import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const repoRoot = join(import.meta.dir, "../../..", "..");
setDefaultTimeout(30_000);

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("runtime companion version assets", () => {
  test("release resolver falls back to the latest component release containing every requested asset", () => {
    const releases = JSON.stringify([
      {
        tag_name: "management-api-v0.39.0",
        draft: false,
        prerelease: false,
        assets: [
          { name: "supacloud-linux-amd64" },
          { name: "SHA256SUMS" },
        ],
      },
      {
        tag_name: "edge-runtime-v0.9.0",
        draft: false,
        prerelease: false,
        assets: [{ name: "supacloud-edge-runtime-linux-amd64" }],
      },
      {
        tag_name: "management-api-v0.38.0",
        draft: false,
        prerelease: false,
        assets: [
          { name: "supacloud-linux-amd64" },
          { name: "web-console-build.tar.gz" },
          { name: "SHA256SUMS" },
        ],
      },
    ]);

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        "source scripts/lib/release_assets.sh && supacloud_select_release management-api supacloud-linux-amd64 web-console-build.tar.gz",
      ],
      { cwd: repoRoot, input: releases, encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).tag_name).toBe("management-api-v0.38.0");
  });

  test("missing release asset URL returns a non-zero status", () => {
    const release = JSON.stringify({
      tag_name: "management-api-v0.38.0",
      assets: [{ name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" }],
    });
    const result = spawnSync(
      "/bin/bash",
      ["-c", 'source scripts/lib/release_assets.sh && supacloud_release_asset_url "$RELEASE" missing'],
      { cwd: repoRoot, env: { ...process.env, RELEASE: release }, encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
  });

  test("setup downloads each component from its own verified release", () => {
    const setup = readRepoFile("setup.sh");

    expect(setup).toContain('source "${SCRIPT_DIR}/scripts/lib/release_assets.sh"');
    expect(setup).toContain("supacloud_fetch_component_release management-api");
    expect(setup).toContain("supacloud_fetch_component_release edge-runtime");
    expect(setup).toContain("supacloud_download_release_asset");
    expect(setup).toContain("ensure_release_attestation_verifier");
    expect(setup).not.toContain("releases/latest/download");
    expect(setup).not.toContain("curl -Lo");
    expect(setup).not.toContain("Studio Password:");
    expect(setup).not.toContain("Database Password:");
    expect(setup).toContain('chmod 600 "$CONFIG_FILE"');
    expect(setup).toContain('CONFIG_FILE="${SUPACLOUD_INSTALL_CONFIG_FILE:-/etc/supabase/install.env}"');
    expect(setup).not.toContain('CONFIG_FILE="config.env"');
    expect(setup).toContain('CADDY_BIN_NAME="supacloud-caddy-linux-amd64"');
    expect(setup).toContain('web-console-build.tar.gz "$CADDY_BIN_NAME"');
    expect(setup).toContain('supacloud_download_release_asset "$management_release" "$CADDY_BIN_NAME"');
    expect(setup).toContain("same-release SHA256 and GitHub attestation verification");
  });

  test("setup fails closed on untrusted existing checkouts and release mode never trusts local artifacts", () => {
    const setup = readRepoFile("setup.sh");
    const installer = readRepoFile("install.sh");

    expect(setup).toContain('SUPACLOUD_INSTALL_DIR:-/opt/supacloud');
    expect(setup).toContain("status --porcelain --untracked-files=no");
    expect(setup).toContain("remote get-url origin");
    expect(setup).toContain('official_origin="https://github.com/zuohuadong/supacloud.git"');
    expect(setup).not.toContain("SUPACLOUD_ALLOWED_ORIGIN");
    expect(setup).not.toContain("SUPACLOUD_REPOSITORY_URL");
    expect(setup).toContain("SUPACLOUD_SETUP_BRANCH");
    expect(setup).toContain("pull --ff-only");
    expect(setup).not.toContain('git pull || log_warn "Code update failed, will use existing version"');
    expect(setup).toContain('SUPACLOUD_SETUP_ARTIFACT_MODE:-release');
    expect(setup).toContain('SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS=true');
    expect(setup).not.toContain("need_management_release");
    expect(setup).toContain('supacloud_download_release_asset "$management_release" "$BIN_NAME" "dist/${BIN_NAME}" binary');
    expect(setup).toContain('supacloud_download_release_asset "$management_release" web-console-build.tar.gz "dist/web-console-build.tar.gz" tar');
    expect(setup).toContain('supacloud_download_release_asset "$management_release" "$CADDY_BIN_NAME" "dist/${CADDY_BIN_NAME}" binary');
    expect(installer).toContain("supacloud_resolve_artifact_policy");
    expect(installer).toContain('SUPACLOUD_RESOLVED_ARTIFACT_MODE="$requested_mode"');
    expect(installer).toContain("deploy_web_console_tar_atomic");
    expect(installer.indexOf('if [[ -n "$local_asset" ]]')).toBeLessThan(
      installer.indexOf('elif [[ -x "$target" ]]'),
    );
  });

  test("forced release installers accept only validated dist binaries and install atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-forced-install-"));
    const dist = join(dir, "dist");
    const managementPackage = join(dir, "packages/management-api");
    const edgePackage = join(dir, "packages/edge-runtime/dist");
    const tools = join(dir, "tools");
    const managementAsset = "supacloud-linux-amd64";
    const edgeAsset = "supacloud-edge-runtime-linux-amd64";
    const target = join(dir, "installed-management");
    try {
      spawnSync("mkdir", ["-p", dist, managementPackage, edgePackage, tools]);
      writeFileSync(join(dir, managementAsset), "root-management");
      writeFileSync(join(managementPackage, managementAsset), "package-management");
      writeFileSync(join(edgePackage, edgeAsset), "package-edge");
      writeFileSync(join(dist, managementAsset), "dist-management");
      writeFileSync(join(dist, edgeAsset), "dist-edge");
      writeFileSync(join(tools, "file"), '#!/bin/sh\necho "ELF 64-bit LSB executable, x86-64"\n');
      chmodSync(join(tools, "file"), 0o755);

      const selected = spawnSync("bash", ["-c", [
        "source install.sh",
        'SCRIPT_DIR="$ROOT"',
        'select_management_binary_source "$MANAGEMENT_ASSET"',
        'select_edge_runtime_binary_source "$EDGE_ASSET"',
        'supacloud_atomic_install_binary "$ROOT/dist/$MANAGEMENT_ASSET" "$MANAGEMENT_ASSET" "$TARGET"',
      ].join("; ")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          ROOT: dir,
          TARGET: target,
          MANAGEMENT_ASSET: managementAsset,
          EDGE_ASSET: edgeAsset,
          SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "true",
        },
        encoding: "utf8",
      });
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toContain(join(dist, managementAsset));
      expect(selected.stdout).toContain(join(dist, edgeAsset));
      expect(readFileSync(target, "utf8")).toBe("dist-management");
      expect(statSync(target).mode & 0o777).toBe(0o755);

      rmSync(join(dist, managementAsset));
      rmSync(join(dist, edgeAsset));
      const missing = spawnSync("bash", ["-c", [
        "source install.sh",
        'SCRIPT_DIR="$ROOT"',
        'select_management_binary_source "$MANAGEMENT_ASSET"',
        'select_edge_runtime_binary_source "$EDGE_ASSET"',
      ].join("; ")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          ROOT: dir,
          MANAGEMENT_ASSET: managementAsset,
          EDGE_ASSET: edgeAsset,
          SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "true",
        },
        encoding: "utf8",
      });
      expect(missing.status).not.toBe(0);

      const local = spawnSync("bash", ["-c", [
        "source install.sh",
        'SCRIPT_DIR="$ROOT"',
        'select_management_binary_source "$MANAGEMENT_ASSET"',
        'select_edge_runtime_binary_source "$EDGE_ASSET"',
      ].join("; ")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${tools}:${process.env.PATH}`,
          ROOT: dir,
          MANAGEMENT_ASSET: managementAsset,
          EDGE_ASSET: edgeAsset,
          SUPACLOUD_SETUP_ARTIFACT_MODE: "local",
          SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "false",
        },
        encoding: "utf8",
      });
      expect(local.status, local.stderr).toBe(0);
      expect(local.stdout).toContain(join(managementPackage, managementAsset));
      expect(local.stdout).toContain(join(edgePackage, edgeAsset));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release artifact policy cannot be downgraded by FORCE=false and every selector stays dist-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-artifact-policy-"));
    const dist = join(dir, "dist");
    const managementPackage = join(dir, "packages/management-api");
    const edgePackage = join(dir, "packages/edge-runtime/dist");
    const webBuild = join(dir, "packages/web-console/build");
    const managementAsset = "supacloud-linux-amd64";
    const edgeAsset = "supacloud-edge-runtime-linux-amd64";
    const caddyAsset = "supacloud-caddy-linux-amd64";
    try {
      mkdirSync(dist, { recursive: true });
      mkdirSync(managementPackage, { recursive: true });
      mkdirSync(edgePackage, { recursive: true });
      mkdirSync(webBuild, { recursive: true });
      const entry = join(dir, "entry.ts");
      const elf = join(dir, "fixture-linux-amd64");
      writeFileSync(entry, "console.log('fixture');\n");
      const compiled = spawnSync("bun", [
        "build", entry, "--compile", "--target=bun-linux-x64", `--outfile=${elf}`,
      ], { encoding: "utf8" });
      expect(compiled.status, compiled.stderr).toBe(0);
      expect(spawnSync("file", [elf], { encoding: "utf8" }).stdout).toContain("ELF");

      copyFileSync(elf, join(managementPackage, managementAsset));
      copyFileSync(elf, join(edgePackage, edgeAsset));
      copyFileSync(elf, join(dir, caddyAsset));
      writeFileSync(join(webBuild, "index.html"), "local web build");

      const invoke = (command: string, extraEnv: Record<string, string> = {}) => spawnSync(
        "bash",
        ["-c", `source install.sh; SCRIPT_DIR="$ROOT"; ${command}`],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            ROOT: dir,
            MANAGEMENT_ASSET: managementAsset,
            EDGE_ASSET: edgeAsset,
            CADDY_ASSET: caddyAsset,
            SUPACLOUD_SETUP_ARTIFACT_MODE: "release",
            SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "false",
            ...extraEnv,
          },
          encoding: "utf8",
        },
      );

      const documentedManagementBuild = invoke(
        'select_management_binary_source "$MANAGEMENT_ASSET"',
        {
          SUPACLOUD_SETUP_ARTIFACT_MODE: "local",
          SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "false",
        },
      );
      expect(documentedManagementBuild.status, documentedManagementBuild.stderr).toBe(0);
      expect(documentedManagementBuild.stdout).toContain(join(managementPackage, managementAsset));
      const documentedEdgeBuild = invoke(
        'select_edge_runtime_binary_source "$EDGE_ASSET"',
        {
          SUPACLOUD_SETUP_ARTIFACT_MODE: "local",
          SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "false",
        },
      );
      expect(documentedEdgeBuild.status, documentedEdgeBuild.stderr).toBe(0);
      expect(documentedEdgeBuild.stdout).toContain(join(edgePackage, edgeAsset));
      const documentedWebBuild = invoke("select_web_console_source", {
        SUPACLOUD_SETUP_ARTIFACT_MODE: "local",
        SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "false",
      });
      expect(documentedWebBuild.status, documentedWebBuild.stderr).toBe(0);
      expect(documentedWebBuild.stdout).toContain(webBuild);

      for (const command of [
        'select_management_binary_source "$MANAGEMENT_ASSET"',
        'select_edge_runtime_binary_source "$EDGE_ASSET"',
        'select_caddy_binary_source "$CADDY_ASSET"',
        "select_web_console_source",
      ]) {
        expect(invoke(command).status).not.toBe(0);
      }

      copyFileSync(elf, join(dist, managementAsset));
      copyFileSync(elf, join(dist, edgeAsset));
      copyFileSync(elf, join(dist, caddyAsset));
      const tarResult = spawnSync("tar", [
        "-czf", join(dist, "web-console-build.tar.gz"), "-C", webBuild, ".",
      ], { encoding: "utf8" });
      expect(tarResult.status, tarResult.stderr).toBe(0);

      const selected = [
        invoke('select_management_binary_source "$MANAGEMENT_ASSET"'),
        invoke('select_edge_runtime_binary_source "$EDGE_ASSET"'),
        invoke('select_caddy_binary_source "$CADDY_ASSET"'),
        invoke("select_web_console_source"),
      ];
      for (const result of selected) {
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain(dist);
      }

      expect(invoke("supacloud_resolve_artifact_policy", {
        SUPACLOUD_SETUP_ARTIFACT_MODE: "local",
        SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "true",
      }).status).not.toBe(0);
      expect(invoke("supacloud_resolve_artifact_policy", {
        SUPACLOUD_SETUP_ARTIFACT_MODE: "invalid",
        SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "false",
      }).status).not.toBe(0);
      const emptyMode = invoke('supacloud_resolve_artifact_policy; printf "%s:%s" "$SUPACLOUD_RESOLVED_ARTIFACT_MODE" "$SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS"', {
        SUPACLOUD_SETUP_ARTIFACT_MODE: "",
        SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS: "false",
      });
      expect(emptyMode.status, emptyMode.stderr).toBe(0);
      expect(emptyMode.stdout).toContain("release:true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("production units use dedicated runtime env files and pinned compiled Edge Runtime commands", () => {
    const installer = readRepoFile("install.sh");
    const managementUnit = readRepoFile("infrastructure/systemd/supacloud.service");
    const edgeUnit = readRepoFile("infrastructure/systemd/supacloud-edge-runtime.service");
    const realtimeUnit = readRepoFile("infrastructure/systemd/supacloud-realtime.service");
    const serviceRenderer = readRepoFile("packages/management-api/src/infra/service.ts");
    const caddyBuilder = readRepoFile("scripts/build_supacloud_caddy.sh");
    const workflow = readRepoFile(".github/workflows/release-please.yml");

    for (const unit of [managementUnit, edgeUnit, realtimeUnit]) {
      expect(unit).not.toContain("/opt/supacloud/config.env");
      expect(unit).toContain("/etc/supabase/management-api.env");
    }
    expect(edgeUnit).toContain("ExecStart=/usr/local/bin/supacloud-edge-runtime");
    expect(installer).toContain("render_edge_runtime_systemd_unit");
    expect(installer).not.toContain('cp "${SYSTEMD_SRC}/supacloud-edge-runtime.service" /etc/systemd/system/supacloud-edge-runtime.service');
    expect(serviceRenderer).not.toContain("/opt/supacloud/config.env");
    expect(serviceRenderer).toContain("/etc/supabase/management-api.env");
    expect(installer).toContain('XCADDY_VERSION="${XCADDY_VERSION:-v0.4.5}"');
    expect(installer).toContain('xcaddy/cmd/xcaddy@${XCADDY_VERSION}');
    expect(workflow).toContain('XCADDY_VERSION: "v0.4.5"');
    expect(workflow).toContain('xcaddy/cmd/xcaddy@${XCADDY_VERSION}');
    expect(caddyBuilder).toContain('XCADDY_VERSION="${XCADDY_VERSION:-v0.4.5}"');
    expect(caddyBuilder).toContain('xcaddy/cmd/xcaddy@${XCADDY_VERSION}');
    expect(installer).not.toContain("xcaddy/cmd/xcaddy@latest");
    expect(workflow).not.toContain("xcaddy/cmd/xcaddy@latest");
    expect(caddyBuilder).not.toContain("xcaddy/cmd/xcaddy@latest");
  });

  test("setup release mode re-resolves and re-verifies all component assets on consecutive runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-setup-release-mode-"));
    const calls = join(dir, "calls.txt");
    try {
      spawnSync("mkdir", ["-p", join(dir, "dist"), join(dir, "packages/web-console/build")]);
      writeFileSync(join(dir, "dist/supacloud-linux-amd64"), "stale-local-management");
      writeFileSync(join(dir, "dist/supacloud-edge-runtime-linux-amd64"), "stale-local-edge");
      writeFileSync(join(dir, "dist/supacloud-caddy-linux-amd64"), "stale-local-caddy");
      writeFileSync(join(dir, "dist/web-console-build.tar.gz"), "stale-local-web");
      writeFileSync(join(dir, "packages/web-console/build/index.html"), "stale-local-build");

      const result = spawnSync("bash", ["-c", [
        `source ${JSON.stringify(join(repoRoot, "setup.sh"))}`,
        'uname() { printf "x86_64\\n"; }',
        'supacloud_fetch_component_release() { printf "fetch:%s\\n" "$1" >> "$CALLS"; printf "{\\\"tag_name\\\":\\\"%s-v1\\\"}" "$1"; }',
        'supacloud_download_release_asset() { printf "asset:%s\\n" "$2" >> "$CALLS"; mkdir -p "$(dirname "$3")"; printf verified > "$3"; }',
        "download_binaries",
        "download_binaries",
      ].join("; ")], {
        cwd: dir,
        env: { ...process.env, CALLS: calls, SUPACLOUD_SETUP_ARTIFACT_MODE: "release" },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      const invocations = readFileSync(calls, "utf8").trim().split("\n");
      expect(invocations.filter((line) => line === "fetch:management-api")).toHaveLength(2);
      expect(invocations.filter((line) => line === "fetch:edge-runtime")).toHaveLength(2);
      for (const asset of [
        "supacloud-linux-amd64",
        "web-console-build.tar.gz",
        "supacloud-caddy-linux-amd64",
        "supacloud-edge-runtime-linux-amd64",
      ]) {
        expect(invocations.filter((line) => line === `asset:${asset}`)).toHaveLength(2);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("setup consumes protected Admin input only after the trusted checkout helper boundary", () => {
    const setup = readRepoFile("setup.sh");
    const helper = readRepoFile("scripts/lib/install_config.sh");
    const trustedHelperIndex = setup.indexOf('source "${SCRIPT_DIR}/scripts/lib/install_config.sh"');
    const consumeIndex = setup.indexOf("consume_setup_install_input || return 1");

    expect(trustedHelperIndex).toBeGreaterThanOrEqual(0);
    expect(consumeIndex).toBeGreaterThan(trustedHelperIndex);
    expect(setup).toContain("SUPACLOUD_SETUP_INPUT_FILE");
    expect(setup).not.toContain('source "$SUPACLOUD_SETUP_INPUT_FILE"');
    expect(setup).not.toContain("proxy_remote");
    expect(setup).not.toContain('git clone --depth 1 --branch "$expected_branch" "${proxy%/}/${repository_url}"');
    for (const command of ["tar", "gzip", "openssl"]) {
      expect(setup).toContain(`command -v ${command}`);
    }
    expect(setup).toContain("python3 tar gzip openssl");
    expect(helper).toContain("supacloud_consume_protected_install_input");

    const dir = mkdtempSync(join(tmpdir(), "supacloud-setup-input-"));
    const input = join(dir, ".install-input-fixture.env");
    const target = join(dir, "install.env");
    try {
      writeFileSync(input, "SUPABASE_PUBLIC_DOMAIN='api.new.example'\nPOSTGRES_PASSWORD='stable-secret'\n");
      chmodSync(input, 0o600);
      writeFileSync(target, "PG_VERSION='17'\nPOSTGRES_PASSWORD='old-secret'\n");
      chmodSync(target, 0o600);
      const consumed = spawnSync("bash", ["-c", [
        "source scripts/lib/install_config.sh",
        'supacloud_consume_protected_install_input "$INPUT" "$TARGET"',
      ].join("; ")], {
        cwd: repoRoot,
        env: { ...process.env, INPUT: input, TARGET: target },
        encoding: "utf8",
      });
      expect(consumed.status, consumed.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toContain("SUPABASE_PUBLIC_DOMAIN='api.new.example'");
      expect(readFileSync(target, "utf8")).toContain("POSTGRES_PASSWORD='stable-secret'");
      expect(readFileSync(target, "utf8")).toContain("PG_VERSION='17'");
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(() => statSync(input)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("setup rejects protected Admin input paths that are not exact UUID filenames", () => {
    const result = spawnSync("bash", ["-c", [
      "source setup.sh",
      "supacloud_consume_protected_install_input() { return 0; }",
      "SUPACLOUD_SETUP_INPUT_FILE=/etc/supabase/.install-input-/../../tmp/evil.env",
      "consume_setup_install_input",
    ].join("; ")], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("must be a unique protected");
  });

  test("setup rejects non-git, dirty, wrong-origin, wrong-branch, and failed fast-forward checkouts", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-setup-checkout-"));
    const seed = join(dir, "seed");
    const remote = join(dir, "remote.git");
    const checkout = join(dir, "checkout");
    const fakeBin = join(dir, "bin");
    const nonGit = join(dir, "not-git");
    const missingRemote = join(dir, "missing.git");
    const officialOrigin = "https://github.com/zuohuadong/supacloud.git";
    const gitBinary = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    const git = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
    const invoke = (installDir: string, reportedOrigin = officialOrigin) => spawnSync("bash", ["-c", [
      `source ${JSON.stringify(join(repoRoot, "setup.sh"))}`,
      "clone_repo",
    ].join("; ")], {
      cwd: repoRoot,
      env: {
        ...process.env,
        SUPACLOUD_INSTALL_DIR: installDir,
        SUPACLOUD_SETUP_BRANCH: "main",
        SUPACLOUD_TEST_REMOTE_URL: reportedOrigin,
        PATH: `${fakeBin}:${process.env.PATH}`,
        GIT_TERMINAL_PROMPT: "0",
      },
      encoding: "utf8",
    });

    try {
      spawnSync("mkdir", ["-p", join(seed, "scripts/lib"), nonGit, fakeBin]);
      writeFileSync(join(fakeBin, "git"), [
        "#!/usr/bin/env bash",
        "if [[ \"$*\" == *\"remote get-url origin\"* ]]; then",
        "  printf '%s\\n' \"$SUPACLOUD_TEST_REMOTE_URL\"",
        "  exit 0",
        "fi",
        `exec ${JSON.stringify(gitBinary)} \"$@\"`,
        "",
      ].join("\n"));
      chmodSync(join(fakeBin, "git"), 0o755);
      expect(git(seed, ["init", "-b", "main"]).status).toBe(0);
      expect(git(seed, ["config", "user.email", "test@example.com"]).status).toBe(0);
      expect(git(seed, ["config", "user.name", "SupaCloud Test"]).status).toBe(0);
      writeFileSync(join(seed, "install.sh"), "#!/bin/bash\n");
      writeFileSync(join(seed, "scripts/lib/install_config.sh"), "#!/bin/bash\n");
      writeFileSync(join(seed, "scripts/lib/release_assets.sh"), "#!/bin/bash\n");
      expect(git(seed, ["add", "."]).status).toBe(0);
      expect(git(seed, ["commit", "-m", "fixture"]).status).toBe(0);
      expect(spawnSync("git", ["init", "--bare", remote], { encoding: "utf8" }).status).toBe(0);
      expect(git(seed, ["remote", "add", "origin", remote]).status).toBe(0);
      expect(git(seed, ["push", "-u", "origin", "main"]).status).toBe(0);
      expect(spawnSync("git", ["clone", "--branch", "main", remote, checkout], { encoding: "utf8" }).status).toBe(0);

      const trustedExisting = invoke(checkout);
      expect(trustedExisting.status, `${trustedExisting.stdout}${trustedExisting.stderr}`).toBe(0);

      writeFileSync(join(checkout, "install.sh"), "dirty\n");
      const dirty = invoke(checkout);
      expect(dirty.status).not.toBe(0);
      expect(`${dirty.stdout}${dirty.stderr}`).toContain("tracked changes");
      expect(git(checkout, ["checkout", "--", "install.sh"]).status).toBe(0);

      expect(git(checkout, ["checkout", "-b", "unexpected"]).status).toBe(0);
      const wrongBranch = invoke(checkout);
      expect(wrongBranch.status).not.toBe(0);
      expect(`${wrongBranch.stdout}${wrongBranch.stderr}`).toContain("expected main");
      expect(git(checkout, ["checkout", "main"]).status).toBe(0);

      const wrongOrigin = invoke(checkout, join(dir, "other.git"));
      expect(wrongOrigin.status).not.toBe(0);
      expect(`${wrongOrigin.stdout}${wrongOrigin.stderr}`).toContain("not trusted");

      expect(git(checkout, ["remote", "set-url", "origin", missingRemote]).status).toBe(0);
      const failedPull = invoke(checkout);
      expect(failedPull.status).not.toBe(0);
      expect(`${failedPull.stdout}${failedPull.stderr}`).toContain("Fast-forward update from the official GitHub HTTPS origin failed");

      const notGit = invoke(nonGit);
      expect(notGit.status).not.toBe(0);
      expect(`${notGit.stdout}${notGit.stderr}`).toContain("not a Git checkout");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pinned GitHub CLI bootstrap uses the reviewed v2.96.0 checksums", () => {
    const helper = readRepoFile("scripts/lib/release_assets.sh");
    expect(helper).toContain('SUPACLOUD_GH_VERSION="${SUPACLOUD_GH_VERSION:-2.96.0}"');
    expect(helper).toContain("83d5c2ccad5498f58bf6368acb1ab32588cf43ab3a4b1c301bf36328b1c8bd60");
    expect(helper).toContain("06f86ec7103d41993b76cd78072f43595c34aaa56506d971d9860e67140bf909");
    expect(helper).toContain("supacloud_install_pinned_gh");
    expect(helper).toContain("2.51.0");
    const versionCheck = spawnSync("bash", ["-c", [
      "source scripts/lib/release_assets.sh",
      "supacloud_version_at_least 2.51.0 2.51.0",
      "! supacloud_version_at_least 2.50.9 2.51.0",
    ].join(" && ")], { cwd: repoRoot, encoding: "utf8" });
    expect(versionCheck.status, versionCheck.stderr).toBe(0);
  });

  test("pinned GitHub CLI archive requires the exact member, checksum, ELF shape, and version", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-gh-bootstrap-"));
    const fixtureRoot = join(dir, "gh_2.96.0_linux_amd64");
    const binDir = join(fixtureRoot, "bin");
    const fakeTools = join(dir, "tools");
    const archive = join(dir, "gh.tar.gz");
    const target = join(dir, "installed-gh");
    try {
      spawnSync("mkdir", ["-p", binDir, fakeTools]);
      writeFileSync(join(binDir, "gh"), '#!/bin/sh\necho "gh version 2.96.0 (fixture)"\n');
      chmodSync(join(binDir, "gh"), 0o755);
      writeFileSync(join(fakeTools, "file"), '#!/bin/sh\necho "ELF 64-bit LSB executable, x86-64"\n');
      chmodSync(join(fakeTools, "file"), 0o755);
      const packed = spawnSync("tar", ["-czf", archive, "-C", dir, "gh_2.96.0_linux_amd64"]);
      expect(packed.status, packed.stderr?.toString()).toBe(0);
      const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");

      const result = spawnSync("bash", ["-c", [
        "source scripts/lib/release_assets.sh",
        'supacloud_install_gh_archive "$ARCHIVE" 2.96.0 amd64 "$CHECKSUM" "$TARGET"',
      ].join("; ")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeTools}:${process.env.PATH}`,
          ARCHIVE: archive,
          CHECKSUM: checksum,
          TARGET: target,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(spawnSync(target, ["--version"], { encoding: "utf8" }).stdout).toContain("2.96.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release workflow publishes keyless GitHub artifact provenance", () => {
    const workflow = readRepoFile(".github/workflows/release-please.yml");

    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("actions/attest-build-provenance@v4");
    expect(workflow).toContain("subject-path: release-assets/*");
    expect(workflow).toContain("subject-path: packages/edge-runtime/dist/*");
    expect(readRepoFile("scripts/lib/release_assets.sh")).toContain("--signer-workflow");
  });

  test("artifact verification fails closed by default and only allows an explicit break-glass", () => {
    const denied = spawnSync(
      "/bin/bash",
      [
        "-c",
        "source scripts/lib/release_assets.sh && supacloud_verify_attestation /tmp/not-used",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: "/nonexistent" },
        encoding: "utf8",
      },
    );

    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain("attestation verification is required");

    const allowed = spawnSync(
      "/bin/bash",
      [
        "-c",
        "source scripts/lib/release_assets.sh && SUPACLOUD_ALLOW_UNVERIFIED_RELEASE=true supacloud_verify_attestation /tmp/not-used",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PATH: "/nonexistent" },
        encoding: "utf8",
      },
    );
    expect(allowed.status, allowed.stderr).toBe(0);
    expect(allowed.stderr).toContain("BREAK-GLASS");
  });

  test("artifact verification fails when gh returns a 404 instead of recording success", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-gh-404-"));
    const fakeBin = join(dir, "bin");
    const gh = join(fakeBin, "gh");
    try {
      spawnSync("mkdir", ["-p", fakeBin]);
      writeFileSync(gh, [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gh version 2.96.0"; exit 0; fi',
        'if [ "$1 $2 $3" = "attestation verify --help" ]; then echo "--signer-workflow"; exit 0; fi',
        'echo "HTTP 404: attestation not found" >&2',
        "exit 22",
        "",
      ].join("\n"));
      chmodSync(gh, 0o755);
      const result = spawnSync("bash", ["-c", "source scripts/lib/release_assets.sh && supacloud_verify_attestation /tmp/artifact"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          SUPACLOUD_INTEGRITY_MODE_RECORD: join(dir, "integrity-mode"),
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("404");
      expect(() => readFileSync(join(dir, "integrity-mode"), "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release downloads try GitHub directly and only use an explicitly configured proxy", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-curl-order-"));
    const calls = join(dir, "calls.txt");
    try {
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "source scripts/lib/release_assets.sh",
            "curl() { printf '%s\\n' \"$*\" >> \"$CALLS\"; return 0; }",
            "export -f curl",
            'supacloud_download_url "https://github.com/acme/release" "$OUTPUT"',
          ].join("; "),
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CALLS: calls,
            OUTPUT: join(dir, "artifact"),
            GH_PROXY: "https://proxy.example.test",
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const invocations = readFileSync(calls, "utf8").trim().split("\n");
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toContain("https://github.com/acme/release");
      expect(invocations[0]).not.toContain("proxy.example.test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Web Console archive validation rejects path traversal entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-release-tar-"));
    const archive = join(dir, "web-console-build.tar.gz");
    try {
      const create = spawnSync("python3", [
        "-c",
        [
          "import io, sys, tarfile",
          "with tarfile.open(sys.argv[1], 'w:gz') as archive:",
          "  for name in ('index.html', '../escape'):",
          "    data = b'x'",
          "    info = tarfile.TarInfo(name)",
          "    info.size = len(data)",
          "    archive.addfile(info, io.BytesIO(data))",
        ].join("\n"),
        archive,
      ]);
      expect(create.status, create.stderr?.toString()).toBe(0);

      const result = spawnSync(
        "/bin/bash",
        ["-c", 'source scripts/lib/release_assets.sh && supacloud_validate_tar "$ARCHIVE"'],
        { cwd: repoRoot, env: { ...process.env, ARCHIVE: archive }, encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pinned tar.xz binary install verifies digest, exact member, ELF architecture, and atomic target mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-pinned-binary-"));
    const payload = join(dir, "payload");
    const fakeTools = join(dir, "tools");
    const archive = join(dir, "auth.tar.xz");
    const unsafeArchive = join(dir, "auth-extra.tar.xz");
    const target = join(dir, "installed-auth");
    try {
      spawnSync("mkdir", ["-p", payload, fakeTools]);
      writeFileSync(join(payload, "auth"), "fixture-elf-binary");
      writeFileSync(join(payload, "extra"), "unexpected-member");
      writeFileSync(join(fakeTools, "file"), '#!/bin/sh\necho "ELF 64-bit LSB executable, x86-64"\n');
      chmodSync(join(fakeTools, "file"), 0o755);
      expect(spawnSync("tar", ["-cJf", archive, "-C", payload, "auth"]).status).toBe(0);
      expect(spawnSync("tar", ["-cJf", unsafeArchive, "-C", payload, "auth", "extra"]).status).toBe(0);
      const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
      const unsafeChecksum = createHash("sha256").update(readFileSync(unsafeArchive)).digest("hex");

      const result = spawnSync("bash", ["-c", [
        "source scripts/lib/release_assets.sh",
        'supacloud_install_pinned_tar_xz_binary "$ARCHIVE" auth "$CHECKSUM" amd64 "$TARGET"',
      ].join("; ")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeTools}:${process.env.PATH}`,
          ARCHIVE: archive,
          CHECKSUM: checksum,
          TARGET: target,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("fixture-elf-binary");
      expect(statSync(target).mode & 0o777).toBe(0o755);

      const rejected = spawnSync("bash", ["-c", [
        "source scripts/lib/release_assets.sh",
        'supacloud_install_pinned_tar_xz_binary "$ARCHIVE" auth "$CHECKSUM" amd64 "$TARGET"',
      ].join("; ")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeTools}:${process.env.PATH}`,
          ARCHIVE: unsafeArchive,
          CHECKSUM: unsafeChecksum,
          TARGET: target,
        },
        encoding: "utf8",
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("must contain only the exact member");
      expect(readFileSync(target, "utf8")).toBe("fixture-elf-binary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installer downloads the current GoTrue release asset names", () => {
    const installer = readRepoFile("install.sh");

    expect(installer).toContain('GOTRUE_VERSION="${GOTRUE_VERSION:-v2.193.0}"');
    expect(installer).toContain('GOTRUE_ARCH="amd64"');
    expect(installer).toContain('GOTRUE_ARCH="arm64"');
    expect(installer).toContain('local GOTRUE_EXT="tar.xz"');
    expect(installer).toContain(
      'auth-${GOTRUE_VERSION}-${GOTRUE_ARCH}.${GOTRUE_EXT}',
    );
    expect(installer).toContain("c991b6fb8747bbcbcef40701177234f152cea28a108a481bae917bacc1a522c5");
    expect(installer).toContain("432fa68ef58afac8665d45537d8adbba5756b01829f175ed7ef6314b3ca59995");
    expect(installer).toContain("supacloud_download_url");
    expect(installer).toContain("supacloud_install_pinned_tar_xz_binary");
    expect(installer).not.toContain("auth-${GOTRUE_VERSION}-${GOTRUE_ARCH}.tar.gz");
    expect(installer).not.toContain('GOTRUE_ARCH="linux-amd64"');
  });

  test("tenant runtime installs the current PostgREST and GoTrue releases", () => {
    const runtime = readRepoFile("scripts/lib/tenant_runtime.sh");

    expect(runtime).toContain('local version="${POSTGREST_VERSION:-v14.15}"');
    expect(runtime).toContain('x86_64) arch="linux-static-x86-64"');
    expect(runtime).toContain('aarch64) arch="ubuntu-aarch64"');
    expect(runtime).toContain("postgrest-${version}-${arch}.tar.xz");

    expect(runtime).toContain('local version="${GOTRUE_VERSION:-v2.193.0}"');
    expect(runtime).toContain('x86_64) arch="amd64"');
    expect(runtime).toContain('aarch64) arch="arm64"');
    expect(runtime).toContain('local archive_ext="tar.xz"');
    expect(runtime).toContain("auth-${version}-${arch}.${archive_ext}");

    expect(runtime).not.toContain('local version="v12.2.3"');
    expect(runtime).not.toContain('local version="v2.189.0"');
    expect(runtime).not.toContain("linux-static-x64");
  });

  test("platform component defaults stay aligned across installers, CI, and Compose", () => {
    const installer = readRepoFile("install.sh");
    const caddyBuilder = readRepoFile("scripts/build_supacloud_caddy.sh");
    const runtime = readRepoFile("scripts/lib/tenant_runtime.sh");
    const realtimeUnit = readRepoFile("infrastructure/systemd/supacloud-realtime.service");
    const workflow = readRepoFile(".github/workflows/management-api.yml");
    const devCompose = readRepoFile("docker/dev/docker-compose.yml");
    const selfHostCompose = readRepoFile("docker/self-host/docker-compose.yml");
    const postgresDockerfile = readRepoFile("docker/self-host/postgres/Dockerfile");

    expect(installer).toContain('local JFS_VER="1.4.0"');
    expect(installer).toContain('COMPOSE_VERSION="v5.3.1"');
    expect(installer).toContain("Docker Buildx >= 0.17 for 'compose build'");
    expect(installer).toContain('CADDY_VERSION:-2.11.4');
    expect(caddyBuilder).toContain('CADDY_VERSION="${CADDY_VERSION:-v2.11.4}"');

    expect(runtime).toContain('POSTGREST_DEFAULT_VERSION="v14.15"');
    expect(runtime).toContain('GOTRUE_DEFAULT_VERSION="v2.193.0"');
    for (const source of [installer, realtimeUnit, workflow]) {
      expect(source).toContain("public.ecr.aws/supabase/realtime:v2.116.1");
    }
    for (const compose of [devCompose, selfHostCompose]) {
      expect(compose).toContain("caddy:2.11.4");
      expect(compose).toContain("supabase/gotrue:v2.193.0");
      expect(compose).toContain("postgrest/postgrest:v14.15");
    }
    expect(workflow).toContain("postgrest/postgrest:v14.15");
    expect(workflow).toContain("supabase/gotrue:v2.193.0");
    expect(postgresDockerfile).toContain("FROM postgres:18-bookworm");
    expect(devCompose).toContain("context: ../self-host/postgres");
    expect(selfHostCompose).toContain("context: ./postgres");
    expect(workflow).toContain("SupaCloud deployment remains PostgreSQL 18");
    expect(workflow).toContain("image: supabase/postgres:17.6.1.143");

    const upgradeNotes = readRepoFile("docs/platform-component-upgrade-notes.md");
    expect(upgradeNotes).toContain("v5 删除内部构建器");
    expect(upgradeNotes).toContain("Docker Buildx >= 0.17");
    expect(upgradeNotes).toContain("postgres:18-bookworm");
    expect(upgradeNotes).toContain("custom_oauth_providers.custom_claims_allowlist");
    expect(upgradeNotes).toContain("storage tiers");
  });
});
