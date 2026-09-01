// @supacloud-test-isolate — compiles and validates multiple release fixtures.
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256,
  SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE,
  SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_TUF_TARGET_SHA256,
} from "../../src/sigstore-trusted-root";

const repoRoot = join(import.meta.dir, "../../..", "..");
setDefaultTimeout(60_000);

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function readShellConstant(script: string, name: string): string {
  const assignment = script.match(new RegExp(`^${name}="([^"]+)"$`, "m"));
  if (!assignment) throw new Error(`Missing shell constant: ${name}`);
  return assignment[1];
}

function readDocumentedComponentVersion(notes: string, component: string): string {
  const componentRow = notes.split("\n").find((line) => line.startsWith(`| ${component} |`));
  if (!componentRow) throw new Error(`Missing component row: ${component}`);
  const currentVersion = componentRow.split("|")[3]?.trim();
  if (!currentVersion) throw new Error(`Missing current version for component: ${component}`);
  return currentVersion;
}

function systemdDirectiveSections(source: string, directive: string): string[] {
  let section = "";
  const sections: string[] = [];
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([A-Za-z]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1]!;
      continue;
    }
    if (line.startsWith(`${directive}=`)) sections.push(section);
  }
  return sections;
}

function readRealtimeImageVersion(systemdUnit: string): string {
  const version = systemdUnit.match(/^Environment=REALTIME_IMAGE=.*:(v[^\s]+)$/m)?.[1];
  if (!version) throw new Error("Missing Realtime image version");
  return version;
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
    expect(setup).toContain("supacloud_fetch_component_release pgredis-runtime");
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
    expect(setup).toContain('official_origin="https://github.com/vibeunion/supacloud.git"');
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
      writeFileSync(join(webBuild, ".supacloud-component.json"), "{}\n");

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
      const archivedWebFiles = spawnSync("tar", [
        "-tzf", join(dist, "web-console-build.tar.gz"),
      ], { encoding: "utf8" });
      expect(archivedWebFiles.status, archivedWebFiles.stderr).toBe(0);
      expect(archivedWebFiles.stdout.split(/\r?\n/)).toContain("./.supacloud-component.json");

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
    const upgrade = readRepoFile("packages/management-api/src/upgrade.ts");
    const managementUnit = readRepoFile("infrastructure/systemd/supacloud.service");
    const edgeUnit = readRepoFile("infrastructure/systemd/supacloud-edge-runtime.service");
    const realtimeUnit = readRepoFile("infrastructure/systemd/supacloud-realtime.service");
    const serviceRenderer = readRepoFile("packages/management-api/src/infra/service.ts");
    const managementConfig = readRepoFile("packages/management-api/src/config.ts");
    const edgeRuntimeManager = readRepoFile("packages/management-api/src/plugins/edge-runtime-manager.ts");
    const edgeRuntimeServer = readRepoFile("packages/edge-runtime/server.ts");
    const sdkProxy = readRepoFile("packages/management-api/src/routes/sdk-proxy.ts");
    const devCompose = readRepoFile("docker/dev/docker-compose.yml");
    const devEnv = readRepoFile("docker/dev/.env.example");
    const selfHostCompose = readRepoFile("docker/self-host/docker-compose.yml");
    const selfHostEnv = readRepoFile("docker/self-host/.env.example");
    const selfHostEnvGenerator = readRepoFile("docker/self-host/init-env.py");
    const edgeDockerfile = readRepoFile("packages/edge-runtime/Dockerfile");
    const selfHostEdgeDockerfile = readRepoFile("docker/self-host/edge-runtime.Dockerfile");
    const caddyBuilder = readRepoFile("scripts/build_supacloud_caddy.sh");
    const workflow = readRepoFile(".github/workflows/release-please.yml");

    for (const unit of [managementUnit, realtimeUnit]) {
      expect(unit).not.toContain("/opt/supacloud/config.env");
      expect(unit).toContain("/etc/supabase/management-api.env");
    }
    expect(edgeUnit).not.toContain("/opt/supacloud/config.env");
    expect(edgeUnit).toContain("/etc/supabase/edge-runtime.env");
    expect(edgeUnit).not.toContain("/etc/supabase/management-api.env");
    expect(edgeUnit).toContain("ExecStart=/usr/local/bin/supacloud-edge-runtime");
    expect(edgeUnit).not.toContain("lsof -iTCP");
    expect(edgeUnit).not.toContain("kill -9");
    expect(installer).toContain("render_edge_runtime_systemd_unit");
    expect(installer).toContain("prepare_management_edge_runtime_source");
    expect(installer).toContain("activate_management_edge_runtime_source");
    expect(installer).toContain("commit_management_edge_runtime_source");
    expect(installer).toContain("rollback_management_edge_runtime_source");
    expect(installer).toContain("supacloud_wait_edge_runtime_source_identity");
    expect(installer).not.toContain('cp -rf "$EDGE_RT_SRC"/* /opt/supacloud/edge-runtime/');
    expect(installer).toContain('SUPACLOUD_EDGE_RUNTIME_SOURCE_IDENTITY_FILE');
    expect(installer).not.toContain('cp "${SYSTEMD_SRC}/supacloud-edge-runtime.service" /etc/systemd/system/supacloud-edge-runtime.service');
    expect(installer).not.toContain("lsof -iTCP");
    expect(installer).not.toContain("kill -9 \\${pid}");
    expect(managementConfig).toContain('getEnv("EDGE_RUNTIME_PORT", "9005")');
    expect(edgeRuntimeManager).toContain('"127.0.0.1:9005"');
    expect(edgeRuntimeServer).toContain("|| 9005");
    expect(sdkProxy).toContain('"127.0.0.1:9005"');
    expect(devCompose).toContain("- PORT=9005");
    expect(devCompose).toContain('"${EDGE_RUNTIME_PORT:-9005}:9005"');
    expect(devEnv).toContain("EDGE_RUNTIME_PORT=9005");
    expect(selfHostCompose).toContain("EDGE_RUNTIME_INTERNAL: edge-runtime:9005");
    expect(selfHostCompose).toContain('"127.0.0.1:${EDGE_RUNTIME_PORT:-9005}:9005"');
    expect(selfHostEnv).toContain("EDGE_RUNTIME_PORT=9005");
    expect(selfHostEnvGenerator).toContain('"EDGE_RUNTIME_PORT=9005"');
    expect(edgeDockerfile).toContain("EXPOSE 9005");
    expect(selfHostEdgeDockerfile).toContain("EXPOSE 9005");
    expect(managementUnit).not.toContain("ReadWritePaths=/etc/supabase /etc/systemd/system ");
    expect(managementUnit).toContain("/run/supacloud-unit-requests");
    expect(managementUnit).toContain("CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID");
    expect(installer).toContain("CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_FOWNER CAP_SETGID CAP_SETUID");
    expect(installer).toContain("ensure_management_privilege_tools_available");
    expect(installer).toContain("for tool in setpriv id");
    expect(upgrade).toContain("verifyBackupPrivilegeDropPreflight();");
    expect(upgrade).toContain("40-management-privilege.conf");
    expect(installer).toContain("configure_management_edge_privilege_dropin");
    expect(installer).toContain(
      'MANAGEMENT_EDGE_PRIVILEGE_DROPIN="${SUPACLOUD_EMBEDDED_EDGE_PRIVILEGE_DROPIN:-/etc/systemd/system/supacloud.service.d/50-embedded-edge-privilege.conf}"',
    );
    expect(installer).toContain(
      'supacloud_capture_file_snapshot "$MANAGEMENT_EDGE_PRIVILEGE_DROPIN" "${transaction_dir}/edge-privilege-dropin"',
    );
    expect(installer).toContain(
      'supacloud_restore_file_snapshot "$MANAGEMENT_EDGE_PRIVILEGE_DROPIN" "${transaction_dir}/edge-privilege-dropin"',
    );
    expect(installer.match(/ensure_management_edge_runtime_ready/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(installer).toContain("systemctl enable --now supacloud-edge-runtime");
    expect(installer).toContain('http://127.0.0.1:${runtime_port}/health');
    expect(managementUnit).toContain("SystemCallFilter=@system-service @chown");
    expect(managementUnit).not.toContain("@privileged");
    expect(installer).toContain("install_tenant_user_helper");
    expect(installer).toContain("install_systemd_unit_broker");
    expect(installer).toContain('supacloud_capture_file_snapshot /usr/local/libexec/supacloud/tenant-user');
    expect(installer).toContain('supacloud_restore_file_snapshot /usr/local/libexec/supacloud/systemd-unit');
    expect(readRepoFile("infrastructure/systemd/supacloud-tenant-user@.service")).toContain(
      "ExecStart=/usr/local/libexec/supacloud/tenant-user %i",
    );
    expect(readRepoFile("scripts/lib/tenant_user.sh")).toContain("^[a-z0-9-]{1,20}$");
    expect(readRepoFile("scripts/lib/tenant_user.sh")).toContain("validate_runtime_user");
    const systemdBrokerUnit = readRepoFile("infrastructure/systemd/supacloud-systemd-unit@.service");
    expect(systemdBrokerUnit).toContain("ExecStart=/usr/local/libexec/supacloud/systemd-unit %i");
    expect(systemdBrokerUnit).toContain("ProtectSystem=strict");
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
      expect(invocations.filter((line) => line === "fetch:pgredis-runtime")).toHaveLength(2);
      for (const asset of [
        "supacloud-linux-amd64",
        "web-console-build.tar.gz",
        "supacloud-caddy-linux-amd64",
        "supacloud-edge-runtime-linux-amd64",
        "supacloud-pgredis-runtime-linux-amd64",
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
    const officialOrigin = "https://github.com/vibeunion/supacloud.git";
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
      const trustedRootDirectory = join(seed, "packages/management-api/src/assets");
      spawnSync("mkdir", ["-p", join(seed, "scripts/lib"), trustedRootDirectory, nonGit, fakeBin]);
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
      copyFileSync(
        join(repoRoot, "packages/management-api/src/assets/sigstore-public-good-trusted-root.jsonl"),
        join(trustedRootDirectory, "sigstore-public-good-trusted-root.jsonl"),
      );
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
    expect(helper).toContain("2.68.0");
    const versionCheck = spawnSync("bash", ["-c", [
      "source scripts/lib/release_assets.sh",
      "supacloud_version_at_least 2.68.0 2.68.0",
      "! supacloud_version_at_least 2.67.9 2.68.0",
    ].join(" && ")], { cwd: repoRoot, encoding: "utf8" });
    expect(versionCheck.status, versionCheck.stderr).toBe(0);
  });

  test("vendors the TUF-reviewed Sigstore Public Good trusted root", () => {
    const assetPath = "packages/management-api/src/assets/sigstore-public-good-trusted-root.jsonl";
    const trustedRoot = readRepoFile(assetPath);
    const helper = readRepoFile("scripts/lib/release_assets.sh");
    const setup = readRepoFile("setup.sh");

    expect(Buffer.byteLength(trustedRoot)).toBe(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SIZE);
    expect(createHash("sha256").update(trustedRoot).digest("hex"))
      .toBe(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256);
    expect(trustedRoot.endsWith("\n")).toBe(true);
    expect(trustedRoot.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(trustedRoot).mediaType)
      .toBe("application/vnd.dev.sigstore.trustedroot+json;version=0.1");
    expect(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_TUF_TARGET_SHA256)
      .toBe("6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66");
    expect(helper).toContain(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256);
    expect(helper).toContain("--custom-trusted-root");
    expect(setup).toContain(assetPath);
  });

  test("shell verification rejects missing, modified, or linked trusted roots", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-trusted-root-"));
    const source = join(repoRoot, "packages/management-api/src/assets/sigstore-public-good-trusted-root.jsonl");
    const valid = join(dir, "valid.jsonl");
    const modified = join(dir, "modified.jsonl");
    const linked = join(dir, "linked.jsonl");
    const prepared = join(dir, "prepared.jsonl");
    try {
      copyFileSync(source, valid);
      writeFileSync(modified, readFileSync(source, "utf8").replace('"mediaType"', '"mediaTypf"'));
      symlinkSync(valid, linked);
      const invoke = (trustedRoot: string, command = "supacloud_attestation_trusted_root_available") => spawnSync(
        "bash",
        ["-c", `source scripts/lib/release_assets.sh && ${command}`],
        {
          cwd: repoRoot,
          env: { ...process.env, SUPACLOUD_ATTESTATION_TRUSTED_ROOT: trustedRoot, OUTPUT: prepared },
          encoding: "utf8",
        },
      );

      expect(invoke(valid).status).toBe(0);
      expect(invoke(join(dir, "missing.jsonl")).status).not.toBe(0);
      expect(invoke(modified).status).not.toBe(0);
      expect(invoke(linked).status).not.toBe(0);
      const preparation = invoke(valid, 'supacloud_prepare_attestation_trusted_root "$OUTPUT"');
      expect(preparation.status, preparation.stderr).toBe(0);
      expect(statSync(prepared).mode & 0o777).toBe(0o600);
      expect(createHash("sha256").update(readFileSync(prepared)).digest("hex"))
        .toBe(SIGSTORE_PUBLIC_GOOD_TRUSTED_ROOT_SHA256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("attestation verification requires a new enough gh with every offline flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-gh-capability-"));
    const gh = join(dir, "gh");
    try {
      writeFileSync(gh, [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gh version ${GH_FAKE_VERSION}"; exit 0; fi',
        'if [ "$1 $2 $3" = "attestation verify --help" ]; then printf "%b" "$GH_HELP_TEXT"; exit 0; fi',
        "exit 1",
        "",
      ].join("\n"));
      chmodSync(gh, 0o755);
      const invoke = (version: string, helpText: string) => spawnSync("bash", ["-c", [
        "source scripts/lib/release_assets.sh",
        "supacloud_attestation_verifier_available",
      ].join(" && ")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          GH_FAKE_VERSION: version,
          GH_HELP_TEXT: helpText,
        },
        encoding: "utf8",
      });
      const flags = [
        "--bundle",
        "--signer-workflow",
        "--source-ref",
        "--custom-trusted-root",
        "--deny-self-hosted-runners",
      ];

      expect(invoke("2.68.0", `${flags.join("\n")}\n`).status).toBe(0);
      expect(invoke("2.67.9", `${flags.join("\n")}\n`).status).not.toBe(0);
      for (const omittedFlag of flags) {
        expect(invoke("2.96.0", `${flags.filter(flag => flag !== omittedFlag).join("\n")}\n`).status)
          .not.toBe(0);
      }
      expect(invoke("2.96.0", "--bundle-from-oci\n--signer-workflow-repository\n--source-ref-pattern\n").status)
        .not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    expect(readRepoFile("scripts/lib/release_assets.sh")).toContain("--deny-self-hosted-runners");
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
    const curl = join(fakeBin, "curl");
    const artifact = join(dir, "artifact");
    const bundleArgumentRecord = join(dir, "gh-bundle-argument.txt");
    try {
      spawnSync("mkdir", ["-p", fakeBin]);
      writeFileSync(artifact, "verified artifact fixture");
      writeFileSync(curl, [
        "#!/bin/sh",
        "printf '%s\\n' '{\"attestations\":[{\"bundle\":{\"mediaType\":\"application/vnd.dev.sigstore.bundle.v0.3+json\"}}]}'",
        "",
      ].join("\n"));
      chmodSync(curl, 0o755);
      writeFileSync(gh, [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gh version 2.96.0"; exit 0; fi',
        'if [ "$1 $2 $3" = "attestation verify --help" ]; then printf "%s\\n" "--bundle" "--signer-workflow" "--source-ref" "--custom-trusted-root" "--deny-self-hosted-runners"; exit 0; fi',
        'while [ "$#" -gt 0 ]; do if [ "$1" = "--bundle" ]; then shift; printf "%s\\n" "$1" > "$GH_BUNDLE_ARGUMENT_RECORD"; break; fi; shift; done',
        'echo "HTTP 404: attestation not found" >&2',
        "exit 22",
        "",
      ].join("\n"));
      chmodSync(gh, 0o755);
      const result = spawnSync("bash", ["-c", "source scripts/lib/release_assets.sh && supacloud_verify_attestation \"$ARTIFACT\""], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          ARTIFACT: artifact,
          GH_BUNDLE_ARGUMENT_RECORD: bundleArgumentRecord,
          TMPDIR: dir,
          SUPACLOUD_INTEGRITY_MODE_RECORD: join(dir, "integrity-mode"),
        },
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("404");
      expect(() => readFileSync(join(dir, "integrity-mode"), "utf8")).toThrow();
      const bundlePath = readFileSync(bundleArgumentRecord, "utf8").trim();
      expect(bundlePath.endsWith("/bundle.jsonl")).toBe(true);
      expect(readdirSync(dir).filter(name => name.startsWith("supacloud-attestation."))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("artifact verification gives gh a temporary JSONL bundle and removes it after success", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-gh-offline-"));
    const fakeBin = join(dir, "bin");
    const artifact = join(dir, "artifact");
    const bundleArgumentRecord = join(dir, "gh-bundle-argument.txt");
    const sourceRefArgumentRecord = join(dir, "gh-source-ref-argument.txt");
    const trustedRootArgumentRecord = join(dir, "gh-trusted-root-argument.txt");
    try {
      spawnSync("mkdir", ["-p", fakeBin]);
      writeFileSync(artifact, "verified artifact fixture");
      writeFileSync(join(fakeBin, "curl"), [
        "#!/bin/sh",
        "printf '%s\\n' '{\"attestations\":[{\"bundle\":{\"mediaType\":\"application/vnd.dev.sigstore.bundle.v0.3+json\"}}]}'",
        "",
      ].join("\n"));
      chmodSync(join(fakeBin, "curl"), 0o755);
      writeFileSync(join(fakeBin, "gh"), [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gh version 2.96.0"; exit 0; fi',
        'if [ "$1 $2 $3" = "attestation verify --help" ]; then printf "%s\\n" "--bundle" "--signer-workflow" "--source-ref" "--custom-trusted-root" "--deny-self-hosted-runners"; exit 0; fi',
        'bundle=""; trusted_root=""; deny_self_hosted=false',
        'while [ "$#" -gt 0 ]; do case "$1" in --bundle) shift; bundle="$1" ;; --custom-trusted-root) shift; trusted_root="$1" ;; --source-ref) shift; printf "%s\\n" "$1" > "$GH_SOURCE_REF_ARGUMENT_RECORD" ;; --deny-self-hosted-runners) deny_self_hosted=true ;; esac; shift; done',
        'printf "%s\\n" "$bundle" > "$GH_BUNDLE_ARGUMENT_RECORD"',
        'printf "%s\\n" "$trusted_root" > "$GH_TRUSTED_ROOT_ARGUMENT_RECORD"',
        'case "$bundle:$trusted_root" in */bundle.jsonl:*/trusted_root.jsonl) test -f "$bundle" && test -f "$trusted_root" && test "$(sha256sum "$trusted_root" | cut -d " " -f 1)" = "3c2cc7f357dc064ec527fdcd78da6e9245c21a381e1abaa0f2b62b186bcac1a1" && test "$deny_self_hosted" = true && exit 0 ;; esac',
        'echo "offline bundle must be an existing bundle.jsonl file" >&2',
        "exit 1",
        "",
      ].join("\n"));
      chmodSync(join(fakeBin, "gh"), 0o755);

      const integrityMode = join(dir, "integrity-mode");
      const result = spawnSync("bash", ["-c", "source scripts/lib/release_assets.sh && supacloud_verify_attestation \"$ARTIFACT\""], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH}`,
          ARTIFACT: artifact,
          GH_BUNDLE_ARGUMENT_RECORD: bundleArgumentRecord,
          GH_SOURCE_REF_ARGUMENT_RECORD: sourceRefArgumentRecord,
          GH_TRUSTED_ROOT_ARGUMENT_RECORD: trustedRootArgumentRecord,
          TMPDIR: dir,
          SUPACLOUD_INTEGRITY_MODE_RECORD: integrityMode,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(bundleArgumentRecord, "utf8").trim().endsWith("/bundle.jsonl")).toBe(true);
      expect(readFileSync(trustedRootArgumentRecord, "utf8").trim().endsWith("/trusted_root.jsonl")).toBe(true);
      expect(readFileSync(sourceRefArgumentRecord, "utf8").trim()).toBe("refs/heads/main");
      expect(readdirSync(dir).filter(name => name.startsWith("supacloud-attestation."))).toEqual([]);
      expect(readFileSync(integrityMode, "utf8").trim()).toBe("github-attestation+same-release-sha256");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release transfers are bounded and try GitHub directly before an explicit proxy", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-curl-order-"));
    const calls = join(dir, "calls.txt");
    try {
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "source scripts/lib/release_assets.sh",
            "curl() {",
            "  printf '%s\\n' \"$*\" >> \"$CALLS\"",
            "  output=''",
            "  while [ \"$#\" -gt 0 ]; do",
            "    if [ \"$1\" = -o ]; then shift; output=\"$1\"; fi",
            "    shift",
            "  done",
            "  test -z \"$output\" || printf '%s\\n' '{}' > \"$output\"",
            "}",
            "export -f curl",
            'supacloud_fetch_release_json "https://api.github.com/repos/acme/releases"',
            'supacloud_download_release_metadata_url "https://github.com/acme/SHA256SUMS" "$METADATA_OUTPUT"',
            'supacloud_download_url "https://github.com/acme/release" "$OUTPUT"',
          ].join("\n"),
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            CALLS: calls,
            METADATA_OUTPUT: join(dir, "SHA256SUMS"),
            OUTPUT: join(dir, "artifact"),
            GH_PROXY: "https://proxy.example.test",
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const invocations = readFileSync(calls, "utf8").trim().split("\n");
      expect(invocations).toHaveLength(3);
      for (const metadataInvocation of invocations.slice(0, 2)) {
        expect(metadataInvocation).toContain("--retry 1 --retry-delay 2 --retry-max-time 60");
        expect(metadataInvocation).toContain("--connect-timeout 15 --max-time 30");
        expect(metadataInvocation).toContain("--speed-limit 128 --speed-time 10");
        expect(metadataInvocation).toContain("--proto =https --proto-redir =https");
      }
      expect(invocations[2]).toContain("--retry 1 --retry-delay 2 --retry-max-time 180");
      expect(invocations[2]).toContain("--connect-timeout 15 --max-time 90");
      expect(invocations[2]).toContain("--speed-limit 128 --speed-time 60");
      expect(invocations[2]).toContain("--proto =https --proto-redir =https");
      expect(invocations[2]).toContain("https://github.com/acme/release");
      expect(invocations.join("\n")).not.toContain("proxy.example.test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release metadata falls back to the explicit proxy without exposing a partial direct response", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-curl-proxy-"));
    const calls = join(dir, "calls.txt");
    try {
      const result = spawnSync("/bin/bash", ["-c", [
        "source scripts/lib/release_assets.sh",
        "curl() {",
        "  printf '%s\\n' \"$*\" >> \"$CALLS\"",
        "  curl_arguments=\"$*\"",
        "  output=''",
        "  while [ \"$#\" -gt 0 ]; do",
        "    if [ \"$1\" = -o ]; then shift; output=\"$1\"; fi",
        "    shift",
        "  done",
        "  case \"$curl_arguments\" in *proxy.example.test*) printf '%s\\n' '{}' > \"$output\"; return 0 ;; esac",
        "  printf '%s' '{partial' > \"$output\"",
        "  return 28",
        "}",
        "export -f curl",
        'supacloud_fetch_release_json "https://api.github.com/repos/acme/releases"',
      ].join("\n")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CALLS: calls,
          GH_PROXY: "https://proxy.example.test",
          SUPACLOUD_GITHUB_PROXY: "",
        },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("{}\n");
      const invocations = readFileSync(calls, "utf8").trim().split("\n");
      expect(invocations).toHaveLength(2);
      expect(invocations[0]).toContain("https://api.github.com/repos/acme/releases");
      expect(invocations[1]).toContain("https://proxy.example.test/https://api.github.com/repos/acme/releases");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("release download signals remove partial files and stop continuation", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-release-signal-"));
    const destination = join(dir, "staged-management");
    const continuation = join(dir, "continued");
    const release = JSON.stringify({
      tag_name: "management-api-v0.50.29",
      assets: [
        { name: "supacloud-linux-amd64", browser_download_url: "https://example.test/management" },
        { name: "SHA256SUMS", browser_download_url: "https://example.test/SHA256SUMS" },
      ],
    });
    try {
      const result = spawnSync("/bin/bash", ["-c", [
        "set -e",
        "source scripts/lib/release_assets.sh",
        "supacloud_download_url() { printf '%s\\n' partial > \"$2\"; /bin/sh -c 'kill -TERM \"$PPID\"'; }",
        'supacloud_download_release_asset "$RELEASE" supacloud-linux-amd64 "$DESTINATION" binary',
        'touch "$CONTINUATION"',
      ].join("\n")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          RELEASE: release,
          DESTINATION: destination,
          CONTINUATION: continuation,
          GH_PROXY: "",
          SUPACLOUD_GITHUB_PROXY: "",
        },
        encoding: "utf8",
      });

      expect(result.status).not.toBe(0);
      expect(existsSync(destination)).toBe(false);
      expect(existsSync(continuation)).toBe(false);
      expect(readdirSync(dir).filter(name => name.startsWith("staged-management."))).toEqual([]);
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

  test("pinned tar.xz binary install allows official sibling members and extracts only the exact target", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-pinned-binary-"));
    const payload = join(dir, "payload");
    const fakeTools = join(dir, "tools");
    const archive = join(dir, "auth.tar.xz");
    const tarLog = join(dir, "tar-extract.log");
    const target = join(dir, "installed-auth");
    try {
      spawnSync("mkdir", ["-p", payload, fakeTools]);
      writeFileSync(join(payload, "auth"), "fixture-elf-binary");
      writeFileSync(join(payload, "gotrue"), "official-sibling-binary");
      writeFileSync(join(payload, "migrations"), "official-sibling-binary");
      writeFileSync(join(fakeTools, "file"), '#!/bin/sh\necho "ELF 64-bit LSB executable, x86-64"\n');
      chmodSync(join(fakeTools, "file"), 0o755);
      writeFileSync(join(fakeTools, "tar"), [
        "#!/bin/sh",
        'for argument in "$@"; do',
        '  if [ "$argument" = "-xJf" ]; then',
        '    printf \'%s\\n\' "$@" > "$TAR_LOG"',
        "    break",
        "  fi",
        "done",
        'exec /usr/bin/tar "$@"',
        "",
      ].join("\n"));
      chmodSync(join(fakeTools, "tar"), 0o755);
      expect(spawnSync("tar", ["-cJf", archive, "-C", payload, "auth", "gotrue", "migrations"]).status).toBe(0);
      const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");

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
          TAR_LOG: tarLog,
          TARGET: target,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("fixture-elf-binary");
      expect(statSync(target).mode & 0o777).toBe(0o755);
      const extractionArgs = readFileSync(tarLog, "utf8").trim().split("\n");
      expect(extractionArgs).toContain("-xJf");
      expect(extractionArgs.at(-1)).toBe("auth");
      expect(extractionArgs).not.toContain("gotrue");
      expect(extractionArgs).not.toContain("migrations");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pinned tar.xz binary install rejects checksum, architecture, duplicate, and linked targets", () => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-pinned-binary-reject-"));
    const payload = join(dir, "payload");
    const symlinkPayload = join(dir, "symlink-payload");
    const hardlinkPayload = join(dir, "hardlink-payload");
    const fakeTools = join(dir, "tools");
    const validArchive = join(dir, "auth-valid.tar.xz");
    const duplicateArchive = join(dir, "auth-duplicate.tar.xz");
    const symlinkArchive = join(dir, "auth-symlink.tar.xz");
    const hardlinkArchive = join(dir, "auth-hardlink.tar.xz");
    const target = join(dir, "installed-auth");
    const install = (archive: string, checksum: string, arch: string) => spawnSync(
      "bash",
      ["-c", [
        "source scripts/lib/release_assets.sh",
        'supacloud_install_pinned_tar_xz_binary "$ARCHIVE" auth "$CHECKSUM" "$ARCH" "$TARGET"',
      ].join("; ")], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${fakeTools}:${process.env.PATH}`,
          ARCHIVE: archive,
          ARCH: arch,
          CHECKSUM: checksum,
          TARGET: target,
        },
        encoding: "utf8",
      },
    );
    try {
      spawnSync("mkdir", ["-p", payload, symlinkPayload, hardlinkPayload, fakeTools]);
      writeFileSync(join(payload, "auth"), "fixture-elf-binary");
      writeFileSync(join(symlinkPayload, "gotrue"), "fixture-elf-binary");
      writeFileSync(join(hardlinkPayload, "gotrue"), "fixture-elf-binary");
      expect(spawnSync("ln", ["-s", "gotrue", join(symlinkPayload, "auth")]).status).toBe(0);
      expect(spawnSync("ln", [join(hardlinkPayload, "gotrue"), join(hardlinkPayload, "auth")]).status).toBe(0);
      writeFileSync(join(fakeTools, "file"), '#!/bin/sh\necho "ELF 64-bit LSB executable, x86-64"\n');
      chmodSync(join(fakeTools, "file"), 0o755);
      expect(spawnSync("tar", ["-cJf", validArchive, "-C", payload, "auth"]).status).toBe(0);
      expect(spawnSync("tar", ["-cJf", duplicateArchive, "-C", payload, "auth", "auth"]).status).toBe(0);
      expect(spawnSync("tar", ["-cJf", symlinkArchive, "-C", symlinkPayload, "auth"]).status).toBe(0);
      expect(spawnSync("tar", ["-cJf", hardlinkArchive, "-C", hardlinkPayload, "gotrue", "auth"]).status).toBe(0);

      const validChecksum = createHash("sha256").update(readFileSync(validArchive)).digest("hex");
      const duplicateChecksum = createHash("sha256").update(readFileSync(duplicateArchive)).digest("hex");
      const symlinkChecksum = createHash("sha256").update(readFileSync(symlinkArchive)).digest("hex");
      const hardlinkChecksum = createHash("sha256").update(readFileSync(hardlinkArchive)).digest("hex");
      expect(install(validArchive, "0".repeat(64), "amd64").status).not.toBe(0);
      expect(install(validArchive, validChecksum, "arm64").status).not.toBe(0);
      const duplicate = install(duplicateArchive, duplicateChecksum, "amd64");
      expect(duplicate.status).not.toBe(0);
      expect(duplicate.stderr).toContain("must contain the exact member once");
      expect(install(symlinkArchive, symlinkChecksum, "amd64").status).not.toBe(0);
      expect(install(hardlinkArchive, hardlinkChecksum, "amd64").status).not.toBe(0);
      expect(() => statSync(target)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installer upgrades GoTrue from the current pinned release", () => {
    const installer = readRepoFile("install.sh");
    const upgrade = readRepoFile("scripts/lib/gotrue_upgrade.sh");

    expect(readShellConstant(upgrade, "SUPACLOUD_GOTRUE_DEFAULT_VERSION")).toBe("v2.196.0");
    expect(installer).toContain('source "${SCRIPT_DIR}/scripts/lib/gotrue_upgrade.sh"');
    expect(installer).toContain(
      'local GOTRUE_VERSION="${GOTRUE_VERSION:-$SUPACLOUD_GOTRUE_DEFAULT_VERSION}"',
    );
    expect(installer).toContain('supacloud_upgrade_gotrue_binary "$GOTRUE_BIN"');
    expect(upgrade).toContain('SUPACLOUD_GOTRUE_RELEASE_ARCH="amd64"');
    expect(upgrade).toContain('SUPACLOUD_GOTRUE_RELEASE_ARCH="arm64"');
    expect(upgrade).toContain(
      'SUPACLOUD_GOTRUE_RELEASE_ASSET="auth-${target_version}-${SUPACLOUD_GOTRUE_RELEASE_ARCH}.tar.xz"',
    );
    expect(upgrade).toContain("0d35d4c06a9ae673d06bc8579aeef6bba6f7551fa7842f9fcdac33ec926e360c");
    expect(upgrade).toContain("6a769c0995578dcf208f43036a814daee741c560078d29df7821025f58652d9b");
    expect(upgrade).toContain("supacloud_download_url");
    expect(upgrade).toContain("supacloud_install_pinned_tar_xz_binary");
    expect(upgrade).not.toContain(".tar.gz");
  });

  test("installer upgrades PostgREST globally while tenant starts only attest pinned runtimes", () => {
    const installer = readRepoFile("install.sh");
    const runtime = readRepoFile("scripts/lib/tenant_runtime.sh");
    const gotrueUpgrade = readRepoFile("scripts/lib/gotrue_upgrade.sh");
    const postgrestUpgrade = readRepoFile("scripts/lib/postgrest_upgrade.sh");

    expect(runtime).toContain('local version="${POSTGREST_VERSION:-$POSTGREST_DEFAULT_VERSION}"');
    expect(runtime).toContain('installed_version=$(postgrest_binary_version "$POSTGREST_BIN")');
    expect(runtime).toContain('if [ "$installed_version" = "$version" ]; then');
    expect(runtime).toContain("run the explicit SupaCloud installer/upgrade");
    expect(runtime).toContain("POSTGREST_VERSION must be a v-prefixed release");
    expect(installer).toContain('source "${SCRIPT_DIR}/scripts/lib/postgrest_upgrade.sh"');
    expect(installer).toContain('supacloud_upgrade_postgrest_binary "$POSTGREST_BIN"');
    expect(postgrestUpgrade).toContain('SUPACLOUD_POSTGREST_RELEASE_ARCH="linux-static-x86-64"');
    expect(postgrestUpgrade).toContain('SUPACLOUD_POSTGREST_RELEASE_ARCH="linux-static-aarch64"');
    expect(postgrestUpgrade).toContain('supacloud_postgrest_active_units > "$active_units"');
    expect(postgrestUpgrade).toContain('supacloud_stop_postgrest_units "$active_units" "$stopped_units"');
    expect(postgrestUpgrade).toContain('supacloud_restart_postgrest_units "$active_units" "$binary_path" "$target_version"');
    expect(postgrestUpgrade).toContain("supacloud_rollback_postgrest_upgrade");
    expect(postgrestUpgrade).toContain("expected v-prefixed release");

    expect(readShellConstant(runtime, "GOTRUE_DEFAULT_VERSION")).toBe(
      readShellConstant(gotrueUpgrade, "SUPACLOUD_GOTRUE_DEFAULT_VERSION"),
    );
    expect(runtime).toContain('local required_version="${GOTRUE_VERSION:-$GOTRUE_DEFAULT_VERSION}"');
    expect(runtime).toContain('installed_version=$(gotrue_binary_version "$GOTRUE_BIN")');
    expect(runtime).toContain("run the explicit SupaCloud installer/upgrade");
    expect(runtime).not.toContain("github.com/supabase/auth/releases/download");

    expect(runtime).not.toContain('local version="v12.2.3"');
    expect(runtime).not.toContain('local version="v2.189.0"');
    expect(runtime).not.toContain("linux-static-x64");
  });

  test("systemd start limits remain Unit-scoped and legacy templates are rewritten", () => {
    const sources = [
      readRepoFile("install.sh"),
      readRepoFile("infrastructure/systemd/supacloud.service"),
      readRepoFile("scripts/lib/tenant_runtime.sh"),
      readRepoFile("scripts/lib/gotrue_upgrade.sh"),
      readRepoFile("packages/management-api/src/services/postgrest-systemd-template.ts"),
      readRepoFile("packages/management-api/src/services/tenant-runtime.service.ts"),
    ];

    for (const source of sources) {
      for (const directive of ["StartLimitBurst", "StartLimitIntervalSec"]) {
        const sections = systemdDirectiveSections(source, directive);
        expect(sections.length).toBeGreaterThan(0);
        expect(sections.every((section) => section === "Unit")).toBe(true);
      }
      const restartSections = systemdDirectiveSections(source, "RestartSec");
      expect(restartSections.length).toBeGreaterThan(0);
      expect(restartSections.every((section) => section === "Service")).toBe(true);
    }

    expect(sources[3]).toContain("supacloud_render_gotrue_systemd_unit");
    expect(sources[3]).toContain('User=supacloud-%i');
    expect(sources[3]).toContain('supacloud_restart_gotrue_units "$active_units" "$target_version" true');
    expect(sources[2]).toContain('! systemd_unit_has_canonical_start_limits "$pgrst_unit"');
    expect(sources[2]).toContain('! systemd_unit_has_canonical_start_limits "$gotrue_unit"');
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

    expect(runtime).toContain('POSTGREST_DEFAULT_VERSION="v16.2"');
    expect(runtime).toContain('GOTRUE_DEFAULT_VERSION="v2.196.0"');
    for (const source of [installer, realtimeUnit, workflow]) {
      expect(source).toContain("public.ecr.aws/supabase/realtime:v2.132.0");
    }
    for (const compose of [devCompose, selfHostCompose]) {
      expect(compose).toContain("image: supacloud-caddy:2.11.4-ratelimit");
      expect(compose).toContain("supabase/gotrue:v2.196.0");
      expect(compose).toContain("postgrest/postgrest:v16.2");
    }
    expect(workflow).toContain("postgrest/postgrest:v16.2");
    expect(workflow).toContain("supabase/gotrue:v2.196.0");
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

  test("platform component upgrade notes match runtime version sources", () => {
    const upgradeNotes = readRepoFile("docs/platform-component-upgrade-notes.md");
    const gotrueUpgrade = readRepoFile("scripts/lib/gotrue_upgrade.sh");
    const tenantRuntime = readRepoFile("scripts/lib/tenant_runtime.sh");
    const realtimeUnit = readRepoFile("infrastructure/systemd/supacloud-realtime.service");

    expect(readDocumentedComponentVersion(upgradeNotes, "GoTrue")).toBe(
      readShellConstant(gotrueUpgrade, "SUPACLOUD_GOTRUE_DEFAULT_VERSION"),
    );
    expect(readDocumentedComponentVersion(upgradeNotes, "PostgREST")).toBe(
      readShellConstant(tenantRuntime, "POSTGREST_DEFAULT_VERSION"),
    );
    expect(readDocumentedComponentVersion(upgradeNotes, "Realtime")).toBe(
      readRealtimeImageVersion(realtimeUnit),
    );
  });
});
