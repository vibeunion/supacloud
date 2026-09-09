import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const commandPath = process.env["PATH"];
if (!commandPath) throw new Error("PATH is required for Caddy build tests");

const builder = readFileSync(
  new URL("../../../../scripts/build_supacloud_caddy.sh", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../../../../.github/workflows/management-api.yml", import.meta.url),
  "utf8",
);
const releaseWorkflow = readFileSync(
  new URL("../../../../.github/workflows/release-please.yml", import.meta.url),
  "utf8",
);
const installer = readFileSync(
  new URL("../../../../install.sh", import.meta.url),
  "utf8",
);
const caddyDockerfile = readFileSync(
  new URL("../../../../docker/self-host/caddy/Dockerfile", import.meta.url),
  "utf8",
);
const caddyEntrypoint = readFileSync(
  new URL("../../../../docker/self-host/caddy/entrypoint.sh", import.meta.url),
  "utf8",
);
const devCompose = readFileSync(
  new URL("../../../../docker/dev/docker-compose.yml", import.meta.url),
  "utf8",
);
const selfHostCompose = readFileSync(
  new URL("../../../../docker/self-host/docker-compose.yml", import.meta.url),
  "utf8",
);

function composeService(source: string, service: string): string {
  const startMarker = `\n  ${service}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing Compose service: ${service}`);
  const body = source.slice(start + startMarker.length);
  const end = body.search(/\n(?:  [a-zA-Z0-9_-]+:|volumes:|networks:)\n/);
  return end < 0 ? body : body.slice(0, end);
}

function workflowJob(source: string, job: string): string {
  const startMarker = `\n  ${job}:\n`;
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing workflow job: ${job}`);
  const body = source.slice(start + startMarker.length);
  const end = body.search(/\n  [a-zA-Z0-9_-]+:\n/);
  return end < 0 ? body : body.slice(0, end);
}

describe("Caddy release build reproducibility", () => {
  test("source, installer, Docker, and release builds pin the same Go and xcaddy versions", () => {
    for (const source of [builder, installer]) {
      expect(source).toContain('GO_VERSION="${GO_VERSION:-1.27.1}"');
      expect(source).toContain('XCADDY_VERSION="${XCADDY_VERSION:-v0.4.7}"');
    }
    expect(installer).toContain('GOTOOLCHAIN="go${GO_VERSION}" GOBIN=/usr/local/bin go install');
    expect(installer).toContain('PATH="/usr/local/bin:$PATH" GO_VERSION="$GO_VERSION" XCADDY_VERSION="$XCADDY_VERSION"');
    expect(installer).not.toContain("if ! command -v xcaddy");
    expect(caddyDockerfile).toContain("ENV GOTOOLCHAIN=go1.27.1");
    for (const source of [workflow, releaseWorkflow]) {
      expect(source).toContain('GO_VERSION: "1.27.1"');
      expect(source).toContain('XCADDY_VERSION: "v0.4.7"');
      const versions = source.match(/^\s+go-version: .+$/gm) ?? [];
      expect(versions.length).toBeGreaterThan(0);
      for (const version of versions) {
        expect(version.trim()).toBe("go-version: ${{ env.GO_VERSION }}");
      }
    }
  });

  test.each([
    { goVersion: "", expected: "go1.27.1", xcaddyVersion: "v0.4.7", succeeds: true },
    { goVersion: "1.26.8", expected: "go1.26.8", xcaddyVersion: "v0.4.7", succeeds: true },
    { goVersion: "", expected: "go1.27.1", xcaddyVersion: "v0.4.5", succeeds: false },
  ])("selects $expected with xcaddy $xcaddyVersion", ({ goVersion, expected, xcaddyVersion, succeeds }) => {
    const dir = mkdtempSync(join(tmpdir(), "supacloud-caddy-build-"));
    try {
      const calls = join(dir, "calls");
      writeFileSync(join(dir, "go"), `#!/bin/sh
printf 'go %s %s\\n' "$GOTOOLCHAIN" "$*" >> "$BUILD_CALLS"
`, { mode: 0o755 });
      writeFileSync(join(dir, "xcaddy"), `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '%s h1:test\\n' "$TEST_XCADDY_VERSION"
  exit 0
fi
printf 'xcaddy %s %s %s %s\\n' "$GOTOOLCHAIN" "$GOOS" "$GOARCH" "$CGO_ENABLED" >> "$BUILD_CALLS"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    printf 'test binary\\n' > "$1"
    exit 0
  fi
  shift
done
exit 1
`, { mode: 0o755 });
      const result = Bun.spawnSync(
        ["bash", fileURLToPath(new URL("../../../../scripts/build_supacloud_caddy.sh", import.meta.url))],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${commandPath}`,
            GO_VERSION: goVersion,
            GOTOOLCHAIN: "local",
            XCADDY_VERSION: "",
            TEST_XCADDY_VERSION: xcaddyVersion,
            BUILD_CALLS: calls,
            CADDY_BUILD_TARGETS: "linux-amd64 linux-arm64",
            OUT_DIR: join(dir, "dist"),
          },
        },
      );
      expect(result.exitCode).toBe(succeeds ? 0 : 1);
      if (!succeeds) {
        expect(result.stderr.toString()).toContain("xcaddy v0.4.7 is required; found v0.4.5");
        return;
      }
      expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
        `go ${expected} version`,
        `xcaddy ${expected} linux amd64 0`,
        `xcaddy ${expected} linux arm64 0`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("pins the rate-limit plugin to an immutable upstream commit", () => {
    expect(builder).toContain("5625512f24f6f59d6f64fb3aafe5eecff0b286db");
    expect(builder).toContain("github.com/mholt/caddy-ratelimit@");
    expect(builder).not.toContain(
      'RATE_LIMIT_MODULE="${RATE_LIMIT_MODULE:-github.com/mholt/caddy-ratelimit}"',
    );
  });

  test("self-host and development Compose build the pinned custom Caddy image", () => {
    expect(caddyDockerfile.match(/^FROM .+$/gm)).toEqual([
      "FROM caddy:2.11.4-builder@sha256:522c540599fa8f6a340b18dea8ee12dfd9d8198347cefa2c4c54344159ae6c0b AS builder",
      "FROM caddy:2.11.4@sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d",
    ]);
    expect(caddyDockerfile).toContain("xcaddy/cmd/xcaddy@v0.4.7");
    expect(caddyDockerfile).toContain(
      "github.com/mholt/caddy-ratelimit@5625512f24f6f59d6f64fb3aafe5eecff0b286db",
    );
    expect(caddyDockerfile).not.toContain("@latest");
    expect(caddyDockerfile).toContain('ENTRYPOINT ["/usr/local/bin/supacloud-caddy-entrypoint"]');

    const devCaddy = composeService(devCompose, "caddy");
    const selfHostCaddy = composeService(selfHostCompose, "caddy");
    expect(devCaddy).toContain("context: ../self-host/caddy");
    expect(selfHostCaddy).toContain("context: ./caddy");
    for (const service of [devCaddy, selfHostCaddy]) {
      expect(service).toContain("image: supacloud-caddy:2.11.4-ratelimit");
      expect(service).toContain('entrypoint: ["/usr/local/bin/supacloud-caddy-entrypoint"]');
      expect(service).not.toContain("image: caddy:2.11.4");
    }
    expect(devCaddy).toContain("./caddy/Caddyfile:/etc/caddy/Caddyfile:ro");
    expect(selfHostCaddy).not.toContain("entrypoint.sh:");
    expect(caddyEntrypoint).toContain('if [ -f "$managed_config" ]');
    expect(caddyEntrypoint).toContain('exec caddy run --config "$managed_config"');
    expect(caddyEntrypoint).toContain('exec caddy run --config "$bootstrap_config" --adapter caddyfile');
  });

  test("integration tests build and run the same supported Caddy image", () => {
    const integration = workflowJob(workflow, "integration-test");
    expect(integration).toContain(
      "docker build --tag supacloud-caddy:2.11.4-ratelimit docker/self-host/caddy",
    );
    expect(integration).toContain("supacloud-caddy:2.11.4-ratelimit list-modules");
    expect(integration).toContain("grep -Fx http.handlers.rate_limit");
    expect(integration).toContain("grep -Fx http.matchers.query");
    expect(integration).toContain(
      '$RUNNER_TEMP/caddy-ci.json:/etc/supacloud/caddy/config.json:ro',
    );
    expect(integration).not.toContain("Setup Go");
    expect(integration).not.toContain("go install");
    expect(integration).not.toMatch(/(?:^|[\s"])(?:docker\.io\/library\/)?caddy:2\.11\.4(?:[\s"\\]|$)/);
    expect(integration).not.toContain("/usr/bin/supacloud-caddy");
  });
});
