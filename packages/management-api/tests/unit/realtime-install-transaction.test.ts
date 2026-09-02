import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = join(import.meta.dir, "../../..", "..");
const installer = join(repoRoot, "install.sh");
const realtimeUnitSource = join(repoRoot, "infrastructure/systemd/supacloud-realtime.service");
const temporaryDirectories: string[] = [];

setDefaultTimeout(20_000);

type ServiceState = "active" | "inactive" | "activating";
type EnableState = "enabled" | "disabled";
type FailureMode = "none" | "build" | "health" | "health-corrupt-snapshot" | "daemon-reload";

interface Fixture {
  root: string;
  bin: string;
  sourceAssets: string;
  transactionParent: string;
  launcher: string;
  builder: string;
  apply: string;
  verify: string;
  containerEnv: string;
  serviceEnv: string;
  managementEnv: string;
  unit: string;
  artifact: string;
  systemState: string;
  enableState: string;
  systemctlLog: string;
  runtimeLog: string;
  curlLog: string;
  daemonFailureMarker: string;
  image: string;
  priorFiles: Map<string, string>;
  priorArtifact: Record<string, string>;
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function readTree(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const visit = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const metadata = statSync(path);
      if (metadata.isDirectory()) visit(path, relative);
      else entries[relative] = readFileSync(path, "utf8");
    }
  };
  visit(root);
  return entries;
}

function findPinnedImage(): string {
  const source = readFileSync(installer, "utf8");
  const image = source.match(/^REALTIME_PINNED_IMAGE="([^"]+@sha256:[0-9a-f]{64})"$/m)?.[1];
  if (image === undefined) throw new Error("install.sh does not define a pinned Realtime image");
  return image;
}

function createFixture(
  serviceState: ServiceState = "active",
  enableState: EnableState = "enabled",
): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "supacloud-realtime-transaction-")));
  temporaryDirectories.push(root);
  const bin = join(root, "bin");
  const sourceAssets = join(root, "source-assets");
  const live = join(root, "live");
  const transactionParent = live;
  const launcher = join(live, "realtime-launcher");
  const builder = join(live, "build-realtime-slot-isolation");
  const apply = join(live, "apply-slot-isolation.py");
  const verify = join(live, "verify_slot_isolation_artifact.py");
  const containerEnv = join(live, "realtime-container.env");
  const serviceEnv = join(live, "realtime-service.env");
  const managementEnv = join(live, "management-api.env");
  const unit = join(live, "supacloud-realtime.service");
  const artifact = join(live, "artifact");
  const systemState = join(root, "service-state");
  const enableStatePath = join(root, "enable-state");
  const systemctlLog = join(root, "systemctl.log");
  const runtimeLog = join(root, "runtime.log");
  const curlLog = join(root, "curl.log");
  const daemonFailureMarker = join(root, "daemon-failed");
  const image = findPinnedImage();

  for (const directory of [bin, sourceAssets, live, artifact]) {
    mkdirSync(directory, { recursive: true });
  }

  const priorFiles = new Map<string, string>([
    [launcher, "prior-launcher\n"],
    [builder, "prior-builder\n"],
    [apply, "prior-apply\n"],
    [verify, "prior-verifier\n"],
    [containerEnv, "PRIOR_CONTAINER_ENV=true\n"],
    [serviceEnv, "PRIOR_SERVICE_ENV=true\n"],
    [managementEnv, "OPERATOR_SETTING=keep\nREALTIME_IMAGE=prior-image\n"],
    [unit, "[Unit]\nDescription=prior realtime unit\n"],
  ]);
  for (const [path, contents] of priorFiles) writeFileSync(path, contents);
  chmodSync(launcher, 0o755);
  chmodSync(builder, 0o755);
  chmodSync(apply, 0o755);
  chmodSync(verify, 0o755);

  mkdirSync(join(artifact, "nested"));
  writeFileSync(join(artifact, "manifest.json"), "{\"generation\":\"prior\"}\n");
  writeFileSync(join(artifact, "prior.beam"), "prior-beam\n");
  writeFileSync(join(artifact, "nested", "keep.txt"), "prior-extra-file\n");
  const priorArtifact = readTree(artifact);

  writeFileSync(systemState, `${serviceState}\n`);
  writeFileSync(enableStatePath, `${enableState}\n`);
  for (const log of [systemctlLog, runtimeLog, curlLog]) writeFileSync(log, "");

  writeExecutable(join(sourceAssets, "realtime-launcher.sh"), [
    "#!/usr/bin/env bash",
    "# candidate-launcher",
    "set -euo pipefail",
    "if [[ \"${1:-}\" == \"--validate-only\" ]]; then",
    "  test -f \"$REALTIME_SLOT_ISOLATION_MANIFEST\"",
    "  test -f \"$REALTIME_SLOT_ISOLATION_BEAM\"",
    "  grep -q '\"generation\":\"candidate\"' \"$REALTIME_SLOT_ISOLATION_MANIFEST\"",
    "  grep -q 'candidate-beam' \"$REALTIME_SLOT_ISOLATION_BEAM\"",
    "  exit 0",
    "fi",
    "exit 0",
    "",
  ].join("\n"));
  writeExecutable(join(sourceAssets, "build_realtime_slot_isolation_beam.sh"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [[ \"${FAKE_REALTIME_BUILD_FAIL:-false}\" == \"true\" ]]; then",
    "  printf 'injected candidate build failure\\n' >&2",
    "  exit 42",
    "fi",
    "output=${1:-$REALTIME_SLOT_ISOLATION_OUTPUT_DIR}",
    "mkdir -p \"$output\"",
    "printf 'candidate-beam\\n' > \"$output/Elixir.Realtime.Tenants.ReplicationConnection.beam\"",
    "printf '{\"generation\":\"candidate\"}\\n' > \"$output/manifest.json\"",
    "chmod 0444 \"$output/Elixir.Realtime.Tenants.ReplicationConnection.beam\" \"$output/manifest.json\"",
    "",
  ].join("\n"));
  writeExecutable(
    join(sourceAssets, "apply-slot-isolation.py"),
    "#!/usr/bin/env python3\n# candidate-apply\n",
  );
  writeExecutable(
    join(sourceAssets, "verify_slot_isolation_artifact.py"),
    "#!/usr/bin/env python3\n# candidate-verifier\n",
  );

  writeExecutable(join(bin, "systemctl"), `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FAKE_SYSTEMCTL_LOG"
command_name="\${1:-}"
shift || true
case "$command_name" in
  is-active)
    state=$(cat "$FAKE_SERVICE_STATE")
    printf '%s\n' "$state"
    [[ "$state" == "active" ]]
    ;;
  is-enabled)
    state=$(cat "$FAKE_ENABLE_STATE")
    printf '%s\\n' "$state"
    [[ "$state" == "enabled" ]]
    ;;
  daemon-reload)
    if grep -q 'candidate-launcher' "$SUPACLOUD_REALTIME_SLOT_ISOLATION_LAUNCHER_FILE" 2>/dev/null; then
      printf 'daemon-reload:candidate\\n' >> "$FAKE_SYSTEMCTL_LOG"
    else
      printf 'daemon-reload:prior\\n' >> "$FAKE_SYSTEMCTL_LOG"
    fi
    if [[ "\${FAKE_REALTIME_DAEMON_FAIL_ONCE:-false}" == "true" && ! -e "$FAKE_DAEMON_FAILURE_MARKER" ]]; then
      : > "$FAKE_DAEMON_FAILURE_MARKER"
      exit 51
    fi
    ;;
  stop)
    printf 'inactive\\n' > "$FAKE_SERVICE_STATE"
    ;;
  start|restart)
    printf 'active\\n' > "$FAKE_SERVICE_STATE"
    ;;
  enable)
    printf 'enabled\\n' > "$FAKE_ENABLE_STATE"
    ;;
  disable)
    printf 'disabled\\n' > "$FAKE_ENABLE_STATE"
    ;;
  reset-failed|list-unit-files|show)
    ;;
  *)
    printf 'unexpected systemctl command: %s\\n' "$command_name" >&2
    exit 90
    ;;
esac
`);

  writeExecutable(join(bin, "runtime"), `#!/usr/bin/env bash
set -u
printf '%s\\n' "$*" >> "$FAKE_RUNTIME_LOG"
case "\${1:-}" in
  image)
    if [[ "\${2:-}" == "inspect" ]]; then
      printf '%s\\n' "$FAKE_IMAGE_REFERENCE"
    fi
    ;;
  inspect)
    printf '%s\\n' "$FAKE_IMAGE_REFERENCE"
    ;;
  pull|tag|rm|stop|start)
    ;;
  *)
    ;;
esac
`);

  writeExecutable(join(bin, "curl"), `#!/usr/bin/env bash
set -u
if grep -q 'candidate-launcher' "$SUPACLOUD_REALTIME_SLOT_ISOLATION_LAUNCHER_FILE" 2>/dev/null; then
  printf 'candidate\\n' >> "$FAKE_CURL_LOG"
  if [[ "\${FAKE_REALTIME_HEALTH_FAIL:-false}" == "true" ]]; then
    if [[ "\${FAKE_CORRUPT_REALTIME_ROLLBACK_SNAPSHOT:-false}" == "true" ]]; then
      for prior in "$REALTIME_INSTALL_TRANSACTION_PARENT"/.supacloud-realtime-install.*/prior-artifact; do
        [[ -e "$prior" ]] && rm -rf -- "$prior"
      done
    fi
    exit 22
  fi
else
  printf 'prior\\n' >> "$FAKE_CURL_LOG"
fi
printf '{"status":"ok"}\\n'
`);
  writeExecutable(join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(join(bin, "install"), [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "mode=",
    "directory=false",
    "args=()",
    "while [[ $# -gt 0 ]]; do",
    "  case \"$1\" in",
    "    -D) shift ;;",
    "    -d) directory=true; shift ;;",
    "    -m) mode=$2; shift 2 ;;",
    "    --) shift; while [[ $# -gt 0 ]]; do args+=(\"$1\"); shift; done ;;",
    "    -*) shift ;;",
    "    *) args+=(\"$1\"); shift ;;",
    "  esac",
    "done",
    "if [[ \"$directory\" == true ]]; then",
    "  for path in \"${args[@]}\"; do",
    "    mkdir -p \"$path\"",
    "    [[ -z \"$mode\" ]] || chmod \"$mode\" \"$path\"",
    "  done",
    "  exit 0",
    "fi",
    "count=${#args[@]}",
    "(( count >= 2 ))",
    "source_path=${args[$((count - 2))]}",
    "target_path=${args[$((count - 1))]}",
    "mkdir -p \"$(dirname \"$target_path\")\"",
    "cp \"$source_path\" \"$target_path\"",
    "[[ -z \"$mode\" ]] || chmod \"$mode\" \"$target_path\"",
    "",
  ].join("\n"));

  return {
    root,
    bin,
    sourceAssets,
    transactionParent,
    launcher,
    builder,
    apply,
    verify,
    containerEnv,
    serviceEnv,
    managementEnv,
    unit,
    artifact,
    systemState,
    enableState: enableStatePath,
    systemctlLog,
    runtimeLog,
    curlLog,
    daemonFailureMarker,
    image,
    priorFiles,
    priorArtifact,
  };
}

function runTransaction(
  fixture: Fixture,
  failure: FailureMode,
  extraEnv: Record<string, string> = {},
) {
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${fixture.bin}:${process.env.PATH ?? ""}`,
    SUPACLOUD_REALTIME_SLOT_ISOLATION_SOURCE_DIR: fixture.sourceAssets,
    REALTIME_SLOT_ISOLATION_SOURCE_DIR: fixture.sourceAssets,
    FAKE_REALTIME_SOURCE_ASSETS: fixture.sourceAssets,
    SUPACLOUD_REALTIME_TRANSACTION_PARENT: fixture.transactionParent,
    REALTIME_INSTALL_TRANSACTION_PARENT: fixture.transactionParent,
    SUPACLOUD_REALTIME_SLOT_ISOLATION_LAUNCHER_FILE: fixture.launcher,
    SUPACLOUD_REALTIME_SLOT_ISOLATION_BUILD_FILE: fixture.builder,
    SUPACLOUD_REALTIME_SLOT_ISOLATION_APPLY_FILE: fixture.apply,
    SUPACLOUD_REALTIME_SLOT_ISOLATION_VERIFY_FILE: fixture.verify,
    SUPACLOUD_REALTIME_SLOT_ISOLATION_ARTIFACT_DIR: fixture.artifact,
    SUPACLOUD_REALTIME_CONTAINER_ENV_FILE: fixture.containerEnv,
    SUPACLOUD_REALTIME_SERVICE_ENV_FILE: fixture.serviceEnv,
    SUPACLOUD_REALTIME_UNIT_FILE: fixture.unit,
    REALTIME_UNIT_FILE: fixture.unit,
    SUPACLOUD_MANAGEMENT_ENV_FILE: fixture.managementEnv,
    CONTAINER_RUNTIME: join(fixture.bin, "runtime"),
    FAKE_SYSTEMCTL_LOG: fixture.systemctlLog,
    FAKE_RUNTIME_LOG: fixture.runtimeLog,
    FAKE_CURL_LOG: fixture.curlLog,
    FAKE_SERVICE_STATE: fixture.systemState,
    FAKE_ENABLE_STATE: fixture.enableState,
    FAKE_DAEMON_FAILURE_MARKER: fixture.daemonFailureMarker,
    FAKE_IMAGE_REFERENCE: fixture.image,
    FAKE_REALTIME_BUILD_FAIL: failure === "build" ? "true" : "false",
    FAKE_REALTIME_HEALTH_FAIL:
      failure === "health" || failure === "health-corrupt-snapshot" ? "true" : "false",
    FAKE_CORRUPT_REALTIME_ROLLBACK_SNAPSHOT:
      failure === "health-corrupt-snapshot" ? "true" : "false",
    FAKE_REALTIME_DAEMON_FAIL_ONCE: failure === "daemon-reload" ? "true" : "false",
    SUPACLOUD_REALTIME_HEALTH_ATTEMPTS: "2",
    SUPACLOUD_REALTIME_HEALTH_DELAY_SECONDS: "0",
    INTERNAL_IP: "127.0.0.1",
    POSTGRES_PASSWORD: "database-secret",
    JWT_SECRET: "jwt-secret-at-least-32-characters-long",
    REALTIME_DB_ENC_KEY: "1234567890abcdef",
    REALTIME_SECRET_KEY_BASE: "realtime-secret-key-base-at-least-32-bytes",
    ...extraEnv,
  };
  const script = [
    "set -u",
    `source ${JSON.stringify(installer)}`,
    "install_realtime_slot_isolation_tools() {",
    '  local source_dir="$FAKE_REALTIME_SOURCE_ASSETS"',
    '  mkdir -p "$(dirname "$2")"',
    '  cp "$source_dir/realtime-launcher.sh" "$2" && chmod 0755 "$2"',
    '  cp "$source_dir/build_realtime_slot_isolation_beam.sh" "$3" && chmod 0755 "$3"',
    '  cp "$source_dir/apply-slot-isolation.py" "$4" && chmod 0755 "$4"',
    '  cp "$source_dir/verify_slot_isolation_artifact.py" "$5" && chmod 0755 "$5"',
    "}",
    'type deploy_realtime_service_transaction >/dev/null 2>&1 || { printf "missing deploy_realtime_service_transaction\\n" >&2; exit 127; }',
    'deploy_realtime_service_transaction "$CONTAINER_RUNTIME" "$FAKE_IMAGE_REFERENCE" "$REALTIME_UNIT_SOURCE"',
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    env: { ...env, REALTIME_UNIT_SOURCE: realtimeUnitSource },
    encoding: "utf8",
    timeout: 15_000,
  });
}

function expectPriorFiles(fixture: Fixture): void {
  for (const [path, contents] of fixture.priorFiles) {
    expect(readFileSync(path, "utf8"), path).toBe(contents);
  }
  expect(readTree(fixture.artifact)).toEqual(fixture.priorArtifact);
}

function expectNoTransactionSnapshot(fixture: Fixture): void {
  expect(
    readdirSync(dirname(fixture.artifact)).filter((entry) =>
      entry.startsWith(".supacloud-realtime-install."),
    ),
  ).toEqual([]);
}

function expectTransactionFunctionWasCalled(result: ReturnType<typeof runTransaction>): void {
  expect(result.status).not.toBe(127);
  expect(result.stderr).not.toContain("missing deploy_realtime_service_transaction");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Realtime installer transaction", () => {
  test("rejects a non-steady service state before pulling an image", () => {
    const fixture = createFixture("activating", "enabled");
    const result = runTransaction(fixture, "none");

    expectTransactionFunctionWasCalled(result);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Cannot transact Realtime while service is in state: activating",
    );
    expectPriorFiles(fixture);
    expect(readFileSync(fixture.runtimeLog, "utf8")).toBe("");
    expectNoTransactionSnapshot(fixture);
  });

  test("rejects an untrusted image before invoking the container runtime", () => {
    const fixture = createFixture();
    const result = runTransaction(fixture, "none", {
      FAKE_IMAGE_REFERENCE: "registry.example.test/realtime:untrusted",
    });

    expectTransactionFunctionWasCalled(result);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Realtime image is outside the pinned trust root",
    );
    expectPriorFiles(fixture);
    expect(readFileSync(fixture.runtimeLog, "utf8")).toBe("");
    expectNoTransactionSnapshot(fixture);
  });

  test.each([
    ["manifest", "SUPACLOUD_REALTIME_SLOT_ISOLATION_MANIFEST"],
    ["BEAM", "SUPACLOUD_REALTIME_SLOT_ISOLATION_BEAM"],
    ["verifier", "SUPACLOUD_REALTIME_SLOT_ISOLATION_VERIFY_FILE"],
  ])("rejects an untrusted %s path before changing live state", (_label, variable) => {
    const fixture = createFixture();
    const result = runTransaction(fixture, "none", {
      [variable]: join(fixture.root, "untrusted-path"),
    });

    expectTransactionFunctionWasCalled(result);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expectPriorFiles(fixture);
    expect(readFileSync(fixture.systemState, "utf8").trim()).toBe("active");
    expect(readFileSync(fixture.enableState, "utf8").trim()).toBe("enabled");
    expect(readFileSync(fixture.runtimeLog, "utf8")).toBe("");
    expect(readFileSync(fixture.systemctlLog, "utf8")).toBe("");
    expectNoTransactionSnapshot(fixture);
  });

  test("candidate build failure leaves live files and service state untouched", () => {
    const fixture = createFixture();
    const result = runTransaction(fixture, "build");

    expectTransactionFunctionWasCalled(result);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("injected candidate build failure");
    expectPriorFiles(fixture);
    expect(readFileSync(fixture.systemState, "utf8").trim()).toBe("active");
    expect(readFileSync(fixture.enableState, "utf8").trim()).toBe("enabled");
    const systemctlCalls = readFileSync(fixture.systemctlLog, "utf8");
    expect(systemctlCalls).not.toMatch(/^(?:stop|start|restart|enable|disable|daemon-reload)\b/m);
    expect(readFileSync(fixture.curlLog, "utf8")).toBe("");
    expectNoTransactionSnapshot(fixture);
  });

  test("health failure restores every Realtime input and revalidates the prior service", () => {
    const fixture = createFixture();
    const result = runTransaction(fixture, "health");

    expectTransactionFunctionWasCalled(result);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expectPriorFiles(fixture);
    expect(readFileSync(fixture.systemState, "utf8").trim()).toBe("active");
    expect(readFileSync(fixture.enableState, "utf8").trim()).toBe("enabled");
    const healthCalls = readFileSync(fixture.curlLog, "utf8").trim().split("\n");
    expect(healthCalls).toEqual(["candidate", "candidate", "prior"]);
    expect(readFileSync(fixture.runtimeLog, "utf8")).toMatch(/(?:^|\n)(?:rm|stop)\b/);
    expectNoTransactionSnapshot(fixture);
  });

  test("a missing rollback artifact never deletes the live candidate generation", () => {
    const fixture = createFixture();
    const result = runTransaction(fixture, "health-corrupt-snapshot");

    expectTransactionFunctionWasCalled(result);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Realtime rollback snapshot is missing its prior artifact",
    );
    expect(readTree(fixture.artifact)).toEqual({
      "Elixir.Realtime.Tenants.ReplicationConnection.beam": "candidate-beam\n",
      "manifest.json": "{\"generation\":\"candidate\"}\n",
    });
    expect(
      readdirSync(dirname(fixture.artifact)).some((entry) =>
        entry.startsWith(".supacloud-realtime-install."),
      ),
    ).toBe(true);
  });

  test("activation failure restores a previously inactive and disabled service", () => {
    const fixture = createFixture("inactive", "disabled");
    const result = runTransaction(fixture, "daemon-reload");

    expectTransactionFunctionWasCalled(result);
    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expectPriorFiles(fixture);
    expect(readFileSync(fixture.systemState, "utf8").trim()).toBe("inactive");
    expect(readFileSync(fixture.enableState, "utf8").trim()).toBe("disabled");
    expect(readFileSync(fixture.systemctlLog, "utf8")).toContain("daemon-reload:candidate");
    expectNoTransactionSnapshot(fixture);
  });

  test("successful activation commits the candidate and removes its rollback snapshot", () => {
    const fixture = createFixture();
    const result = runTransaction(fixture, "none");

    expectTransactionFunctionWasCalled(result);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(fixture.launcher, "utf8")).toContain("candidate-launcher");
    expect(readFileSync(fixture.builder, "utf8")).toContain("FAKE_REALTIME_BUILD_FAIL");
    expect(readFileSync(fixture.apply, "utf8")).toContain("candidate-apply");
    expect(readFileSync(fixture.verify, "utf8")).toContain("candidate-verifier");
    expect(readFileSync(fixture.containerEnv, "utf8")).not.toContain("PRIOR_CONTAINER_ENV");
    expect(readFileSync(fixture.serviceEnv, "utf8")).not.toContain("PRIOR_SERVICE_ENV");
    expect(readFileSync(fixture.managementEnv, "utf8")).toContain("OPERATOR_SETTING=keep");
    expect(readFileSync(fixture.managementEnv, "utf8")).toContain("REALTIME_IMAGE=prior-image");
    expect(readFileSync(fixture.managementEnv, "utf8")).toContain(
      'REALTIME_ADMIN_URL="http://127.0.0.1:4000"',
    );
    expect(readFileSync(fixture.unit, "utf8")).toContain("SupaCloud Realtime Service");
    expect(readTree(fixture.artifact)).toEqual({
      "Elixir.Realtime.Tenants.ReplicationConnection.beam": "candidate-beam\n",
      "manifest.json": "{\"generation\":\"candidate\"}\n",
    });
    expect(readFileSync(fixture.systemState, "utf8").trim()).toBe("active");
    expect(readFileSync(fixture.enableState, "utf8").trim()).toBe("enabled");
    expect(readFileSync(fixture.curlLog, "utf8")).toContain("candidate");
    expectNoTransactionSnapshot(fixture);
    expect(existsSync(fixture.daemonFailureMarker)).toBe(false);
  });
});
