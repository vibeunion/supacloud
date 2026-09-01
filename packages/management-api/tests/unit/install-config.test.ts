import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";

const repoRoot = resolve(import.meta.dir, "../../../..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "supacloud-install-config-"));
  tempDirs.push(dir);
  return dir;
}

function runBash(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("installer configuration persistence", () => {
  test("recognizes only Unit-scoped systemd start limits as canonical", () => {
    const dir = makeTempDir();
    const canonical = join(dir, "canonical.service");
    const misplaced = join(dir, "misplaced.service");
    writeFileSync(canonical, [
      "[Unit]",
      "StartLimitBurst=3",
      "StartLimitIntervalSec=60",
      "[Service]",
      "RestartSec=5",
      "",
    ].join("\n"));
    writeFileSync(misplaced, [
      "[Unit]",
      "Description=test",
      "[Service]",
      "RestartSec=5",
      "StartLimitBurst=3",
      "StartLimitIntervalSec=60",
      "",
    ].join("\n"));

    const accepted = runBash(
      'source scripts/lib/install_config.sh && supacloud_systemd_unit_has_canonical_start_limits "$UNIT"',
      { UNIT: canonical },
    );
    const rejected = runBash(
      'source scripts/lib/install_config.sh && supacloud_systemd_unit_has_canonical_start_limits "$UNIT"',
      { UNIT: misplaced },
    );

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(rejected.status).not.toBe(0);
  });

  test("configures a dedicated pgBackRest file and archive command without using Pigsty defaults", () => {
    const dir = makeTempDir();
    const fakeBin = join(dir, "bin");
    const config = join(dir, "supabase", "pgbackrest.conf");
    const repo = join(dir, "repo");
    const calls = join(dir, "calls");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "sudo"), [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "-u" ]]; then shift 2; fi',
      'exec "$@"',
    ].join("\n"), { mode: 0o755 });
    writeFileSync(join(fakeBin, "chown"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(fakeBin, "pg_isready"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(fakeBin, "pgbackrest"), [
      "#!/usr/bin/env bash",
      'printf "pgbackrest:%s\\n" "$*" >> "$CALLS"',
      "exit 0",
    ].join("\n"), { mode: 0o755 });
    writeFileSync(join(fakeBin, "psql"), [
      "#!/usr/bin/env bash",
      'printf "psql:%s\\n" "$*" >> "$CALLS"',
      "exit 0",
    ].join("\n"), { mode: 0o755 });

    const result = runBash([
      "source install.sh",
      "configure_pgbackrest_juicefs",
    ].join("; "), {
      PATH: `${fakeBin}:${process.env.PATH}`,
      CALLS: calls,
      SUPACLOUD_PGBACKREST_CONFIG_FILE: config,
      SUPACLOUD_PGBACKREST_REPO_DIR: repo,
      SUPACLOUD_PGBACKREST_PGDATA_DIR: join(dir, "pgdata"),
      SUPACLOUD_PGBACKREST_STANZA: "db-main",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(config, "utf8")).toContain(`repo1-path=${repo}`);
    expect(readFileSync(config, "utf8")).toContain(`[db-main]`);
    expect(readFileSync(config, "utf8")).toContain(`pg1-path=${join(dir, "pgdata")}`);
    expect(readFileSync(calls, "utf8")).toContain(`--config=${config}`);
    expect(readFileSync(calls, "utf8")).toContain(`--stanza=db-main`);
    expect(readFileSync(calls, "utf8")).toContain("ALTER SYSTEM SET archive_command");
  });

  test("atomically merges managed values while preserving operator-owned settings", () => {
    const dir = makeTempDir();
    const target = join(dir, "config.env");
    const desired = join(dir, "desired.env");
    writeFileSync(target, "CUSTOM_SETTING=keep-me\nPOSTGRES_PASSWORD=old\n", { mode: 0o644 });
    writeFileSync(desired, "POSTGRES_PASSWORD=stable-secret\nSUPABASE_PUBLIC_DOMAIN=api.example.com\n");

    const result = runBash(
      'source scripts/lib/install_config.sh && supacloud_atomic_merge_env "$TARGET" "$DESIRED"',
      { TARGET: target, DESIRED: desired },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(target, "utf8")).toContain("CUSTOM_SETTING=keep-me");
    expect(readFileSync(target, "utf8")).toContain("POSTGRES_PASSWORD=stable-secret");
    expect(readFileSync(target, "utf8")).toContain("SUPABASE_PUBLIC_DOMAIN=api.example.com");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("setup install input safely round-trips quotes, command substitutions, spaces, and newlines", () => {
    const dir = makeTempDir();
    const config = join(dir, "install.env");
    const marker = join(dir, "must-not-exist");
    const firstDomain = join(dir, "first-domain.txt");
    const firstPassword = join(dir, "first-password.txt");
    const secondDomain = join(dir, "second-domain.txt");
    const secondPassword = join(dir, "second-password.txt");
    const domain = `api.\"$(touch ${marker})\" example\nsecond-line`;
    const password = `p a\"ss $(touch ${marker})\npassword-line`;

    const result = runBash([
      "source scripts/lib/install_config.sh",
      'supacloud_write_install_input_config "$CONFIG"',
      "unset SUPABASE_PUBLIC_DOMAIN DASHBOARD_PASSWORD",
      'source "$CONFIG"',
      'printf %s "$SUPABASE_PUBLIC_DOMAIN" > "$FIRST_DOMAIN"',
      'printf %s "$DASHBOARD_PASSWORD" > "$FIRST_PASSWORD"',
      "unset SUPABASE_PUBLIC_DOMAIN DASHBOARD_PASSWORD",
      'source "$CONFIG"',
      'printf %s "$SUPABASE_PUBLIC_DOMAIN" > "$SECOND_DOMAIN"',
      'printf %s "$DASHBOARD_PASSWORD" > "$SECOND_PASSWORD"',
    ].join("; "), {
      CONFIG: config,
      FIRST_DOMAIN: firstDomain,
      FIRST_PASSWORD: firstPassword,
      SECOND_DOMAIN: secondDomain,
      SECOND_PASSWORD: secondPassword,
      SUPABASE_PUBLIC_DOMAIN: domain,
      DASHBOARD_PASSWORD: password,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(() => statSync(marker)).toThrow();
    expect(readFileSync(firstDomain, "utf8")).toBe(domain);
    expect(readFileSync(firstPassword, "utf8")).toBe(password);
    expect(readFileSync(secondDomain, "utf8")).toBe(domain);
    expect(readFileSync(secondPassword, "utf8")).toBe(password);
    expect(statSync(config).mode & 0o777).toBe(0o600);

    const setup = readFileSync(join(repoRoot, "setup.sh"), "utf8");
    expect(setup).toContain('supacloud_write_install_input_config "$CONFIG_FILE"');
    expect(setup).not.toContain('cat > "$desired_config" << EOF');
  });

  test("setup generate_config is idempotent across consecutive runs and preserves domain and credentials", () => {
    const dir = makeTempDir();
    const config = join(dir, "install.env");
    const first = join(dir, "first.env");
    const result = runBash([
      "source setup.sh",
      "source scripts/lib/install_config.sh",
      "generate_config",
      'cp "$CONFIG_FILE" "$FIRST"',
      'SUPABASE_PUBLIC_DOMAIN="api.changed.invalid"',
      'SUPABASE_STUDIO_DOMAIN="studio.changed.invalid"',
      'POSTGRES_PASSWORD="changed-database"',
      'DASHBOARD_PASSWORD="changed-dashboard"',
      "generate_config",
      'cmp "$FIRST" "$CONFIG_FILE"',
    ].join("; "), {
      SUPACLOUD_INSTALL_CONFIG_FILE: config,
      FIRST: first,
      INTERNAL_IP: "10.20.30.40",
      SUPABASE_PUBLIC_DOMAIN: "api.stable.example",
      SUPABASE_STUDIO_DOMAIN: "studio.stable.example",
      POSTGRES_PASSWORD: "stable-database",
      DASHBOARD_PASSWORD: "stable-dashboard",
      GRAFANA_PASSWORD: "stable-grafana",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(config, "utf8")).toContain("SUPABASE_PUBLIC_DOMAIN=api.stable.example");
    expect(readFileSync(config, "utf8")).toContain("POSTGRES_PASSWORD=stable-database");
    expect(readFileSync(config, "utf8")).not.toContain("changed-database");
  });

  test("install input validation rejects executable syntax, CRLF, unknown keys, and malformed lines without execution", () => {
    const dir = makeTempDir();
    const template = join(dir, "template.env");
    const jwtKeys = join(dir, "jwt.env");
    const marker = join(dir, "must-not-run");
    writeFileSync(template, "PG_VERSION=18\n");

    const invalidInputs = [
      `POSTGRES_PASSWORD=$(touch ${marker})\n`,
      "PG_VERSION=18\r\n",
      "UNKNOWN_INSTALL_KEY=value\n",
      "echo not-an-assignment\n",
      "POSTGRES_PASSWORD='unterminated\n",
    ];

    for (const [index, contents] of invalidInputs.entries()) {
      const installInput = join(dir, `invalid-${index}.env`);
      writeFileSync(installInput, contents);
      const result = runBash("source install.sh; load_install_config_layers", {
        SUPACLOUD_TEMPLATE_CONFIG_FILE: template,
        SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
        SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
      });
      expect(result.status, `case ${index}: ${result.stderr}`).not.toBe(0);
      expect(() => statSync(marker)).toThrow();
    }
  });

  test("check_config rejects unsafe IP and DNS inputs before logging or persistence", () => {
    const dir = makeTempDir();
    const marker = join(dir, "install-input-must-not-run");
    const originalConfig = [
      "INTERNAL_IP=10.20.30.40",
      "SUPABASE_PUBLIC_DOMAIN=api.safe.example",
      "SUPABASE_STUDIO_DOMAIN=studio.safe.example",
      "POSTGRES_PASSWORD=stable-database-secret",
      "DASHBOARD_PASSWORD=stable-dashboard-secret",
      "GRAFANA_PASSWORD=stable-grafana-secret",
      "",
    ].join("\n");
    const invalidInputs = [
      { key: "INTERNAL_IP", value: "10.0.0.8|e /tmp/injected" },
      { key: "INTERNAL_IP", value: "2001:db8::1" },
      { key: "INTERNAL_IP", value: "999.0.0.1" },
      { key: "INTERNAL_IP", value: "010.0.0.1" },
      { key: "SUPABASE_PUBLIC_DOMAIN", value: "https://api.example.test:443/path" },
      { key: "SUPABASE_PUBLIC_DOMAIN", value: `api.$(touch ${marker}).example.test` },
      { key: "SUPABASE_PUBLIC_DOMAIN", value: "api.example.test|injected" },
      { key: "SUPABASE_PUBLIC_DOMAIN", value: "api..example.test" },
      { key: "SUPABASE_STUDIO_DOMAIN", value: "studio example.test" },
      { key: "SUPABASE_STUDIO_DOMAIN", value: "studio.example.test\nINJECTED=yes" },
      { key: "SUPABASE_STUDIO_DOMAIN", value: "studio.example.test&injected" },
      { key: "SUPABASE_STUDIO_DOMAIN", value: "studio.example.test." },
    ];

    for (const [index, invalid] of invalidInputs.entries()) {
      const installInput = join(dir, `unsafe-${index}.env`);
      const jwtKeys = join(dir, `unsafe-${index}-jwt.env`);
      const downstreamMarker = join(dir, `unsafe-${index}-downstream`);
      writeFileSync(installInput, originalConfig, { mode: 0o600 });

      const result = runBash('source install.sh; check_config; printf reached > "$DOWNSTREAM_MARKER"', {
        SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
        SUPACLOUD_TEMPLATE_CONFIG_FILE: join(dir, "missing-template.env"),
        SUPACLOUD_CREDENTIALS_FILE: join(dir, "missing-credentials.env"),
        SUPACLOUD_MANAGEMENT_ENV_FILE: join(dir, "missing-runtime.env"),
        SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
        DOWNSTREAM_MARKER: downstreamMarker,
        [invalid.key]: invalid.value,
      });

      expect(result.status, `${invalid.key}: ${result.stdout}\n${result.stderr}`).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(invalid.value);
      expect(readFileSync(installInput, "utf8")).toBe(originalConfig);
      expect(() => statSync(jwtKeys)).toThrow();
      expect(() => statSync(marker)).toThrow();
      expect(() => statSync(downstreamMarker)).toThrow();
    }
  }, 30_000);

  test("install input rejects removed Logflare configuration before persistence", () => {
    const dir = makeTempDir();
    const installInput = join(dir, "removed-logflare.env");
    const jwtKeys = join(dir, "removed-logflare-jwt.env");
    const downstreamMarker = join(dir, "removed-logflare-downstream");
    const originalConfig = [
      "INTERNAL_IP=10.20.30.40",
      "SUPABASE_PUBLIC_DOMAIN=api.safe.example",
      "SUPABASE_STUDIO_DOMAIN=studio.safe.example",
      "POSTGRES_PASSWORD=stable-database-secret",
      "DASHBOARD_PASSWORD=stable-dashboard-secret",
      "GRAFANA_PASSWORD=stable-grafana-secret",
      "ENABLE_ANALYTICS=true",
      "",
    ].join("\n");
    writeFileSync(installInput, originalConfig, { mode: 0o600 });

    const result = runBash('source install.sh; check_config; printf reached > "$DOWNSTREAM_MARKER"', {
      SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
      SUPACLOUD_TEMPLATE_CONFIG_FILE: join(dir, "missing-template.env"),
      SUPACLOUD_CREDENTIALS_FILE: join(dir, "missing-credentials.env"),
      SUPACLOUD_MANAGEMENT_ENV_FILE: join(dir, "missing-runtime.env"),
      SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
      DOWNSTREAM_MARKER: downstreamMarker,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("unsupported key: ENABLE_ANALYTICS");
    expect(readFileSync(installInput, "utf8")).toBe(originalConfig);
    expect(() => statSync(jwtKeys)).toThrow();
    expect(() => statSync(downstreamMarker)).toThrow();
  });

  test("check_config rejects the legacy Supabase compose stack before installation", () => {
    const dir = makeTempDir();
    const installInput = join(dir, "legacy-compose.env");
    const jwtKeys = join(dir, "legacy-compose-jwt.env");
    const originalConfig = [
      "INTERNAL_IP=10.20.30.40",
      "SUPABASE_PUBLIC_DOMAIN=api.safe.example",
      "SUPABASE_STUDIO_DOMAIN=studio.safe.example",
      "POSTGRES_PASSWORD=stable-database-secret",
      "DASHBOARD_PASSWORD=stable-dashboard-secret",
      "GRAFANA_PASSWORD=stable-grafana-secret",
      "SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK=true",
      "",
    ].join("\n");
    writeFileSync(installInput, originalConfig, { mode: 0o600 });

    const result = runBash("source install.sh; check_config", {
      SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
      SUPACLOUD_TEMPLATE_CONFIG_FILE: join(dir, "missing-template.env"),
      SUPACLOUD_CREDENTIALS_FILE: join(dir, "missing-credentials.env"),
      SUPACLOUD_MANAGEMENT_ENV_FILE: join(dir, "missing-runtime.env"),
      SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("legacy stack installs Supabase Analytics (Logflare)");
    expect(readFileSync(installInput, "utf8")).toBe(originalConfig);
    expect(() => statSync(jwtKeys)).toThrow();
  });

  test("check_config rejects an unsafe VictoriaLogs data directory before installation", () => {
    const dir = makeTempDir();
    const installInput = join(dir, "unsafe-victorialogs-path.env");
    const jwtKeys = join(dir, "unsafe-victorialogs-path-jwt.env");
    writeFileSync(installInput, [
      "INTERNAL_IP=10.20.30.40",
      "SUPABASE_PUBLIC_DOMAIN=api.safe.example",
      "SUPABASE_STUDIO_DOMAIN=studio.safe.example",
      "POSTGRES_PASSWORD=stable-database-secret",
      "DASHBOARD_PASSWORD=stable-dashboard-secret",
      "GRAFANA_PASSWORD=stable-grafana-secret",
      "VICTORIALOGS_DATA_DIR=/",
      "",
    ].join("\n"), { mode: 0o600 });

    const result = runBash("source install.sh; check_config", {
      SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
      SUPACLOUD_TEMPLATE_CONFIG_FILE: join(dir, "missing-template.env"),
      SUPACLOUD_CREDENTIALS_FILE: join(dir, "missing-credentials.env"),
      SUPACLOUD_MANAGEMENT_ENV_FILE: join(dir, "missing-runtime.env"),
      SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("VICTORIALOGS_DATA_DIR must be a non-root directory");
    expect(() => statSync(jwtKeys)).toThrow();
  });

  test("check_config preserves valid IPv4 and nip.io domains across consecutive runs", () => {
    const dir = makeTempDir();
    const installInput = join(dir, "nip-io.env");
    const jwtKeys = join(dir, "nip-io-jwt.env");
    writeFileSync(installInput, [
      "INTERNAL_IP=10.20.30.40",
      "SUPABASE_PUBLIC_DOMAIN=api.10.20.30.40.nip.io",
      "SUPABASE_STUDIO_DOMAIN=studio.10.20.30.40.nip.io",
      "POSTGRES_PASSWORD=stable-database-secret",
      "DASHBOARD_PASSWORD=stable-dashboard-secret",
      "GRAFANA_PASSWORD=stable-grafana-secret",
      "",
    ].join("\n"), { mode: 0o600 });
    const env = {
      SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
      SUPACLOUD_TEMPLATE_CONFIG_FILE: join(dir, "missing-template.env"),
      SUPACLOUD_CREDENTIALS_FILE: join(dir, "missing-credentials.env"),
      SUPACLOUD_MANAGEMENT_ENV_FILE: join(dir, "missing-runtime.env"),
      SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
    };

    const first = runBash("source install.sh; check_config", env);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    const firstConfig = readFileSync(installInput, "utf8");
    const firstJwt = readFileSync(jwtKeys, "utf8");

    const second = runBash("source install.sh; check_config", env);
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expect(readFileSync(installInput, "utf8")).toBe(firstConfig);
    expect(readFileSync(jwtKeys, "utf8")).toBe(firstJwt);
    expect(firstConfig).toContain("SUPABASE_PUBLIC_DOMAIN=api.10.20.30.40.nip.io");
    expect(firstConfig).toContain("SUPABASE_STUDIO_DOMAIN=studio.10.20.30.40.nip.io");
  });

  test("strict install input parser round-trips a safely escaped command-substitution literal", () => {
    const dir = makeTempDir();
    const template = join(dir, "template.env");
    const installInput = join(dir, "install.env");
    const marker = join(dir, "escaped-command-must-not-run");
    const output = join(dir, "value.txt");
    const literal = `password $(touch ${marker}) with spaces`;
    writeFileSync(template, "PG_VERSION=18\n");

    const written = runBash(
      'source scripts/lib/install_config.sh; supacloud_write_install_input_config "$CONFIG"',
      { CONFIG: installInput, DASHBOARD_PASSWORD: literal },
    );
    expect(written.status, written.stderr).toBe(0);

    const loaded = runBash([
      "source install.sh",
      "load_install_config_layers",
      'printf %s "$DASHBOARD_PASSWORD" > "$OUTPUT"',
    ].join("; "), {
      SUPACLOUD_TEMPLATE_CONFIG_FILE: template,
      SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
      OUTPUT: output,
    });
    expect(loaded.status, loaded.stderr).toBe(0);
    expect(() => statSync(marker)).toThrow();
    expect(readFileSync(output, "utf8")).toBe(literal);
  });

  test("service environment encoding is source-safe, round-trips special characters, and rejects newlines", () => {
    const dir = makeTempDir();
    const target = join(dir, "management-api.env");
    const marker = join(dir, "service-env-command-must-not-run");
    const sourced = join(dir, "sourced.txt");
    const parsed = join(dir, "parsed.txt");
    const value = `p a\"ss\\word $(touch ${marker}) \`touch ${marker}\` $HOME`;

    const result = runBash([
      "source scripts/lib/install_config.sh",
      'supacloud_write_service_env_pairs "$TARGET" PGPASSWORD "$VALUE" S3_SECRET_KEY "$VALUE"',
      "unset PGPASSWORD S3_SECRET_KEY",
      'source "$TARGET"',
      'printf %s "$PGPASSWORD" > "$SOURCED"',
      'supacloud_env_value "$TARGET" S3_SECRET_KEY > "$PARSED"',
    ].join("; "), {
      TARGET: target,
      VALUE: value,
      SOURCED: sourced,
      PARSED: parsed,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(() => statSync(marker)).toThrow();
    expect(readFileSync(sourced, "utf8")).toBe(value);
    expect(readFileSync(parsed, "utf8")).toBe(value);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    const before = readFileSync(target, "utf8");

    const rejected = runBash(
      'source scripts/lib/install_config.sh; supacloud_write_service_env_pairs "$TARGET" PGPASSWORD "$VALUE"',
      { TARGET: target, VALUE: "first-line\nINJECTED=yes" },
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("must be a single line");
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  test("JWT and unified credential files cannot execute user-controlled values when sourced", () => {
    const dir = makeTempDir();
    const jwtFile = join(dir, "jwt-keys.env");
    const credentials = join(dir, "credentials.env");
    const marker = join(dir, "credential-command-must-not-run");
    const jwtCopy = join(dir, "jwt.txt");
    const dbCopy = join(dir, "database.txt");
    const s3Copy = join(dir, "s3.txt");
    const jwt = `jwt \"secret\" $(touch ${marker})\nsecond-line`;
    const database = `db p\"ass\\word $(touch ${marker})`;
    const s3 = `s3 secret with spaces \`touch ${marker}\` $HOME`;

    const result = runBash([
      "source install.sh",
      "generate_jwt_keys",
      "unset JWT_SECRET",
      'source "$JWT_FILE"',
      'printf %s "$JWT_SECRET" > "$JWT_COPY"',
      'JWT_SECRET="$CREDENTIAL_JWT"',
      "save_all_credentials",
      "unset JWT_SECRET POSTGRES_PASSWORD S3_SECRET_KEY",
      'source "$CREDENTIALS"',
      'printf %s "$POSTGRES_PASSWORD" > "$DB_COPY"',
      'printf %s "$S3_SECRET_KEY" > "$S3_COPY"',
    ].join("; "), {
      SUPACLOUD_JWT_KEYS_FILE: jwtFile,
      SUPACLOUD_CREDENTIALS_FILE: credentials,
      JWT_FILE: jwtFile,
      CREDENTIALS: credentials,
      JWT_COPY: jwtCopy,
      DB_COPY: dbCopy,
      S3_COPY: s3Copy,
      JWT_SECRET: jwt,
      CREDENTIAL_JWT: `credential jwt $(touch ${marker})`,
      ANON_KEY: "anon key",
      SERVICE_ROLE_KEY: "service role key",
      INTERNAL_IP: "127.0.0.1",
      SUPABASE_PUBLIC_DOMAIN: `api.$(touch ${marker}).example.test`,
      SUPABASE_STUDIO_DOMAIN: "studio.example.test",
      POSTGRES_PASSWORD: database,
      GRAFANA_PASSWORD: "grafana password",
      S3_STORAGE_TYPE: "external",
      S3_SECRET_KEY: s3,
      MASTER_TOKEN: "management token",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(() => statSync(marker)).toThrow();
    expect(readFileSync(jwtCopy, "utf8")).toBe(jwt);
    expect(readFileSync(dbCopy, "utf8")).toBe(database);
    expect(readFileSync(s3Copy, "utf8")).toBe(s3);
    expect(statSync(jwtFile).mode & 0o777).toBe(0o600);
    expect(statSync(credentials).mode & 0o777).toBe(0o600);
  });

  test("installer keeps tracked templates separate and never weakens host SSH or publishes the master token", () => {
    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");

    expect(installer).toContain('TEMPLATE_CONFIG_FILE="${SUPACLOUD_TEMPLATE_CONFIG_FILE:-${SCRIPT_DIR}/config.env}"');
    expect(installer).toContain('INSTALL_INPUT_FILE="${SUPACLOUD_INSTALL_CONFIG_FILE:-/etc/supabase/install.env}"');
    expect(installer).not.toContain("sync_runtime_config()");
    expect(installer).not.toContain("sync_runtime_config /etc/supabase/management-api.env");
    expect(installer).not.toContain("PermitRootLogin yes");
    expect(installer).not.toContain("StrictModes no");
    expect(installer).not.toContain("PasswordAuthentication yes");
    expect(installer).toContain("--connection=local");
    expect(installer).toContain("rm -f /etc/ssh/sshd_config.d/00-supacloud-test.conf");
    expect(installer).not.toContain('export MASTER_TOKEN="${MASTER_TOKEN}"');
    expect(installer).not.toContain('echo -e "  ${YELLOW}MASTER_TOKEN=${MASTER_TOKEN}${NC}"');
    expect(installer).toContain('source "${SCRIPT_DIR}/scripts/lib/release_assets.sh"');
    expect(installer).toContain('SELECTED_BIN_SOURCE=$(select_management_binary_source "$CI_BIN")');
    expect(installer).toContain('supacloud_atomic_install_binary "$SELECTED_BIN_SOURCE" "$CI_BIN" "$staged_management_binary"');
    expect(installer).not.toContain("releases/latest/download");
    expect(installer).not.toContain('-v realtime_password="${POSTGRES_PASSWORD}"');
    expect(installer).not.toContain("PASSWORD '$DB_PASS'");
    expect(installer).not.toMatch(/sed -i[^\n]*\$\{?(POSTGRES_PASSWORD|DASHBOARD_PASSWORD|GRAFANA_PASSWORD|JWT_SECRET|ANON_KEY|SERVICE_ROLE_KEY|S3_ACCESS_KEY|S3_SECRET_KEY|LOGFLARE_DB_URL)/);
    expect(installer).not.toContain('openssl dgst -sha256 -hmac "$JWT_SECRET"');
    expect(installer).not.toContain('supabase_admin:${POSTGRES_PASSWORD}@');
    expect(installer).not.toContain('postgresql://postgres:${POSTGRES_PASSWORD}@');
    expect(installer).toContain('postgresql://postgres:${encoded_postgres_password}@');
    expect(installer).not.toContain('-e DB_PASSWORD="${POSTGRES_PASSWORD}"');
    expect(installer).not.toContain('-e JWT_SECRET="${JWT_SECRET}"');
    expect(installer).toContain('--env-file "$realtime_env_file"');
    expect(installer).toContain('supacloud_write_shell_env_pairs "$JWT_KEYS_FILE"');
    expect(installer).toContain('supacloud_write_service_env_pairs "$CREDENTIALS_FILE"');
    expect(installer).toContain('supacloud_write_service_env_pairs "$MANAGEMENT_ENV_FILE"');
    expect(installer).toContain('supacloud_atomic_remove_env_key "$INSTALL_INPUT_FILE"');
    expect(installer).toContain('SECRETS_ENCRYPTION_KEY SUPAOAUTH_BFF_SIGNING_SECRET SUPABASE_SCHEMA_PATH');
    expect(installer).not.toContain('JWT_SECRET="${JWT_SECRET}"');
    expect(installer).not.toContain('PGPASSWORD=${POSTGRES_PASSWORD}');
    expect(installer).not.toContain('sed -i "s|ERL_AFLAGS=.*|ERL_AFLAGS=${LOGFLARE_ERL_FLAGS}|g"');
    expect(installer).toContain('supacloud_write_raw_env_pairs "$SUPABASE_ENV"');
  });

  test("management runtime env receives installer identity, network, and storage settings", () => {
    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");
    const start = installer.indexOf('supacloud_write_service_env_pairs "$MANAGEMENT_ENV_FILE"', installer.indexOf("# 5. Generate API service environment file"));
    const end = installer.indexOf("# 6. Execute database migration", start);
    const runtimeEnvWrite = installer.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    for (const key of [
      "INTERNAL_IP",
      "DOCKER_HOST_IP",
      "DASHBOARD_USERNAME",
      "DASHBOARD_PASSWORD",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_ACCESS_KEY",
      "S3_SECRET_KEY",
      "SUPAOAUTH_BFF_SIGNING_SECRET",
      "S3_BUCKET",
      "S3_FORCE_PATH_STYLE",
    ]) {
      expect(runtimeEnvWrite).toContain(`${key} `);
    }
  });

  test("Pigsty secret patching reads a protected input and emits valid quoted YAML scalars", () => {
    const dir = makeTempDir();
    const config = join(dir, "pigsty.yml");
    writeFileSync(config, [
      "DASHBOARD_PASSWORD: pigsty",
      "POSTGRES_PASSWORD: DBUser.Supa",
      "  password: 'DBUser.Supa'",
      "grafana_admin_password: pigsty",
      "JWT_SECRET: your-super-secret-jwt-token-with-at-least-32-characters-long",
      "ANON_KEY: old-anon",
      "SERVICE_ROLE_KEY: old-service",
      "SUPABASE_PUBLISHABLE_KEY: old-publishable",
      "SUPABASE_SECRET_KEY: old-secret",
      "",
    ].join("\n"));

    const result = runBash(
      'source scripts/lib/install_config.sh; supacloud_patch_pigsty_secrets "$CONFIG" "$DASH" "$POSTGRES" "$GRAFANA" "$JWT" "$ANON" "$SERVICE" "$PUBLISHABLE" "$SECRET"',
      {
        CONFIG: config,
        DASH: "dash'|secret",
        POSTGRES: "db'|secret",
        GRAFANA: "graf'|secret",
        JWT: "jwt'|secret",
        ANON: "anon'|secret",
        SERVICE: "service'|secret",
        PUBLISHABLE: "sb_publishable_test-value",
        SECRET: "sb_secret_test-value",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const patched = readFileSync(config, "utf8");
    expect(patched).toContain('DASHBOARD_PASSWORD: "dash\'|secret"');
    expect(patched).toContain('POSTGRES_PASSWORD: "db\'|secret"');
    expect(patched).toContain('password: "db\'|secret"');
    expect(patched).toContain('JWT_SECRET: "jwt\'|secret"');
    expect(patched).toContain('SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test-value"');
    expect(patched).toContain('SUPABASE_SECRET_KEY: "sb_secret_test-value"');
  });

  test("JuiceFS uses a root-only pgpass file and a password-free metadata URL", () => {
    const dir = makeTempDir();
    const pgpass = join(dir, "juicefs.pgpass");
    const result = runBash(
      'source scripts/lib/install_config.sh; supacloud_write_pgpass "$PGPASS" db.example 5432 juicefs supabase_admin "$PASSWORD"',
      { PGPASS: pgpass, PASSWORD: "pa:ss\\word" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(pgpass, "utf8")).toBe("db.example:5432:juicefs:supabase_admin:pa\\:ss\\\\word\n");
    expect(statSync(pgpass).mode & 0o777).toBe(0o600);

    const failedPgpass = join(dir, "failed.pgpass");
    const failed = runBash([
      "source scripts/lib/install_config.sh",
      "mv() { return 1; }",
      "export -f mv",
      'supacloud_write_pgpass "$PGPASS" db.example 5432 juicefs supabase_admin "$PASSWORD"',
    ].join("; "), { PGPASS: failedPgpass, PASSWORD: "temporary-secret" });
    expect(failed.status).not.toBe(0);
    const leftovers = runBash('compgen -G "${PGPASS}.tmp.*" || true', { PGPASS: failedPgpass });
    expect(leftovers.stdout).toBe("");

    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");
    expect(installer).toContain('PGPASSFILE="$JUICEFS_PGPASS_FILE" juicefs status "$META_URL"');
    expect(installer).toContain('Environment=PGPASSFILE=${JUICEFS_PGPASS_FILE}');
    expect(installer).not.toContain('postgres://supabase_admin:${POSTGRES_PASSWORD}@');
    expect(installer).not.toContain("desired_juicefs_env");
    expect(installer).not.toContain("desired_s3_env");
    expect(installer).not.toContain("desired_logflare_env");
    expect(installer).not.toContain("desired_runtime_env");
    expect(installer).toContain("supacloud_write_raw_env_pairs");
  });

  test("Realtime container receives secrets through a 0600 env file that is removed by the EXIT trap", () => {
    const dir = makeTempDir();
    const argsFile = join(dir, "args.txt");
    const envCopy = join(dir, "env-copy.txt");
    const modeFile = join(dir, "mode.txt");
    const pathFile = join(dir, "path.txt");
    const result = runBash([
      "source install.sh",
      'fake_runtime() { printf "%s\\n" "$*" > "$ARGS_FILE"; while [ "$#" -gt 0 ]; do if [ "$1" = "--env-file" ]; then printf "%s" "$2" > "$PATH_FILE"; cp "$2" "$ENV_COPY"; python3 -c "import os,sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777))" "$2" > "$MODE_FILE"; shift 2; else shift; fi; done; }',
      "export -f fake_runtime",
      'start_realtime_container fake_runtime "realtime:test" "supacloud-realtime"',
    ].join("; "), {
      ARGS_FILE: argsFile,
      ENV_COPY: envCopy,
      MODE_FILE: modeFile,
      PATH_FILE: pathFile,
      INTERNAL_IP: "10.0.0.8",
      POSTGRES_PASSWORD: "db-secret",
      JWT_SECRET: "jwt-secret",
      REALTIME_DB_ENC_KEY: "1234567890123456",
      REALTIME_SECRET_KEY_BASE: "realtime-secret",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(argsFile, "utf8")).not.toContain("db-secret");
    expect(readFileSync(argsFile, "utf8")).not.toContain("jwt-secret");
    expect(readFileSync(argsFile, "utf8")).toContain("--env-file");
    expect(readFileSync(envCopy, "utf8")).toContain("DB_PASSWORD=db-secret");
    expect(readFileSync(envCopy, "utf8")).toContain("JWT_SECRET=jwt-secret");
    expect(readFileSync(modeFile, "utf8").trim()).toBe("0o600");
    expect(() => statSync(readFileSync(pathFile, "utf8"))).toThrow();
  });

  test("CLI profile preserves DOCKER_HOST without exposing the master token", () => {
    const dir = makeTempDir();
    const profile = join(dir, "supacloud.sh");
    writeFileSync(
      profile,
      "export DOCKER_HOST=unix:///var/run/podman/podman.sock\nexport MASTER_TOKEN=previously-leaked-token\n",
    );

    const result = runBash(
      'source scripts/lib/install_config.sh && supacloud_write_cli_profile "$PROFILE"',
      { PROFILE: profile },
    );

    expect(result.status, result.stderr).toBe(0);
    const contents = readFileSync(profile, "utf8");
    expect(contents).toContain("export DOCKER_HOST=unix:///var/run/podman/podman.sock");
    expect(contents).toContain("export MANAGEMENT_API_URL=http://localhost:9090");
    expect(contents).not.toContain("alias sc='supacloud'");
    expect(contents).not.toContain("MASTER_TOKEN");
    expect(statSync(profile).mode & 0o777).toBe(0o644);
  });

  test("tracked placeholders plus root credentials resolve idempotently without modifying the template", () => {
    const dir = makeTempDir();
    const template = join(dir, "config.env");
    const installInput = join(dir, "install.env");
    const credentials = join(dir, "supacloud-credentials.env");
    const runtime = join(dir, "management-api.env");
    const jwtKeys = join(dir, "jwt-keys.env");
    const trackedTemplate = [
      'INTERNAL_IP=""',
      'SUPABASE_PUBLIC_DOMAIN="supa.example.com"',
      'SUPABASE_STUDIO_DOMAIN=""',
      'POSTGRES_PASSWORD="DBUser.Supa"',
      'DASHBOARD_PASSWORD="supacloud"',
      'GRAFANA_PASSWORD="supacloud"',
      'PG_VERSION="18"',
      'PIGSTY_VERSION="latest"',
      'S3_STORAGE_TYPE="juicefs"',
      "CUSTOM_SETTING=template-only",
      "",
    ].join("\n");
    writeFileSync(template, trackedTemplate);
    writeFileSync(credentials, [
      "INTERNAL_IP=10.10.0.8",
      "PUBLIC_DOMAIN=api.example.test",
      "STUDIO_DOMAIN=studio.example.test",
      "POSTGRES_PASSWORD=database-secret",
      "DASHBOARD_PASSWORD=dashboard-secret",
      "GRAFANA_PASSWORD=grafana-secret",
      "JWT_SECRET=stable-jwt-secret-that-is-at-least-32-bytes",
      "ANON_KEY=stable-anon",
      "SERVICE_ROLE_KEY=stable-service",
      "PG_VERSION=17",
      "PIGSTY_VERSION=v4.3.0",
      "S3_STORAGE_TYPE=external",
      "JUICEFS_BACKEND=postgres",
      "S3_ENDPOINT=https://legacy-s3.example.test",
      "S3_PROTOCOL=https",
      "S3_REGION=eu-west-1",
      "S3_BUCKET=legacy-bucket",
      "S3_ACCESS_KEY=legacy-access",
      "S3_SECRET_KEY=legacy-secret",
      "S3_FORCE_PATH_STYLE=false",
      "EXTERNAL_S3_ENDPOINT=https://s3.example.test",
      "EXTERNAL_S3_REGION=ap-southeast-1",
      "EXTERNAL_S3_BUCKET=project-data",
      "EXTERNAL_S3_ACCESS_KEY=external-access",
      "EXTERNAL_S3_SECRET_KEY=external-secret",
      "",
    ].join("\n"));
    writeFileSync(runtime, "BASE_DOMAIN=runtime-wrong.test\nPGPASSWORD=runtime-wrong\n");

    const first = runBash(
      'source install.sh && check_config',
      {
        SUPACLOUD_TEMPLATE_CONFIG_FILE: template,
        SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
        SUPACLOUD_CREDENTIALS_FILE: credentials,
        SUPACLOUD_MANAGEMENT_ENV_FILE: runtime,
        SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
      },
    );
    expect(first.status, first.stderr).toBe(0);
    const firstConfig = readFileSync(installInput, "utf8");
    const firstJwtKeys = readFileSync(jwtKeys, "utf8");

    const second = runBash('source install.sh && check_config', {
      SUPACLOUD_TEMPLATE_CONFIG_FILE: template,
      SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
      SUPACLOUD_CREDENTIALS_FILE: credentials,
      SUPACLOUD_MANAGEMENT_ENV_FILE: runtime,
      SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
    });
    expect(second.status, second.stderr).toBe(0);

    expect(readFileSync(installInput, "utf8")).toBe(firstConfig);
    expect(readFileSync(jwtKeys, "utf8")).toBe(firstJwtKeys);
    expect(readFileSync(template, "utf8")).toBe(trackedTemplate);
    expect(firstConfig).toContain("SUPABASE_PUBLIC_DOMAIN=api.example.test");
    expect(firstConfig).toContain("SUPABASE_STUDIO_DOMAIN=studio.example.test");
    expect(firstConfig).toContain("POSTGRES_PASSWORD=database-secret");
    expect(firstConfig).toContain("PG_VERSION=17");
    expect(firstConfig).toContain("PIGSTY_VERSION=v4.3.0");
    for (const setting of [
      "S3_STORAGE_TYPE=external",
      "S3_ENDPOINT=https://legacy-s3.example.test",
      "S3_PROTOCOL=https",
      "S3_REGION=eu-west-1",
      "S3_BUCKET=legacy-bucket",
      "S3_ACCESS_KEY=legacy-access",
      "S3_SECRET_KEY=legacy-secret",
      "S3_FORCE_PATH_STYLE=false",
      "EXTERNAL_S3_ENDPOINT=https://s3.example.test",
      "EXTERNAL_S3_REGION=ap-southeast-1",
      "EXTERNAL_S3_BUCKET=project-data",
      "EXTERNAL_S3_ACCESS_KEY=external-access",
      "EXTERNAL_S3_SECRET_KEY=external-secret",
    ]) {
      expect(firstConfig).toContain(setting);
    }
  }, 15_000);

  test("explicit environment and CLI values override persisted install input", () => {
    const dir = makeTempDir();
    const template = join(dir, "config.env");
    const installInput = join(dir, "install.env");
    const jwtKeys = join(dir, "jwt-keys.env");
    writeFileSync(template, "PG_VERSION=18\nS3_STORAGE_TYPE=juicefs\n");
    writeFileSync(installInput, [
      "INTERNAL_IP=10.0.0.4",
      "SUPABASE_PUBLIC_DOMAIN=api.persisted.test",
      "SUPABASE_STUDIO_DOMAIN=studio.persisted.test",
      "POSTGRES_PASSWORD=persisted-password",
      "DASHBOARD_PASSWORD=persisted-dashboard",
      "GRAFANA_PASSWORD=persisted-grafana",
      "PG_VERSION=16",
      "S3_STORAGE_TYPE=minio",
      "",
    ].join("\n"));

    const result = runBash(
      'set -- --domain api.cli.test --s3 external; source install.sh; check_config; printf "RESULT=%s|%s|%s\n" "$SUPABASE_PUBLIC_DOMAIN" "$S3_STORAGE_TYPE" "$PG_VERSION"',
      {
        SUPACLOUD_TEMPLATE_CONFIG_FILE: template,
        SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
        SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
        PG_VERSION: "17",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("RESULT=api.cli.test|external|17");
  });

  test("persisted external and minio storage selections override the tracked juicefs template", () => {
    const dir = makeTempDir();
    const template = join(dir, "config.env");
    const jwtKeys = join(dir, "jwt-keys.env");
    writeFileSync(template, "S3_STORAGE_TYPE=juicefs\nPG_VERSION=18\n");

    for (const storageType of ["external", "minio"]) {
      const installInput = join(dir, `${storageType}.env`);
      writeFileSync(installInput, [
        "INTERNAL_IP=10.0.0.7",
        "SUPABASE_PUBLIC_DOMAIN=api.storage.test",
        "SUPABASE_STUDIO_DOMAIN=studio.storage.test",
        "POSTGRES_PASSWORD=database-secret",
        "DASHBOARD_PASSWORD=dashboard-secret",
        "GRAFANA_PASSWORD=grafana-secret",
        `S3_STORAGE_TYPE=${storageType}`,
        "",
      ].join("\n"));
      const result = runBash(
        'source install.sh; load_install_config_layers; printf "RESULT=%s\\n" "$S3_STORAGE_TYPE"',
        {
          SUPACLOUD_TEMPLATE_CONFIG_FILE: template,
          SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
          SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`RESULT=${storageType}`);
    }
  });

  test("container runtime env is atomically merged and refuses a missing JWT", () => {
    const dir = makeTempDir();
    const runtime = join(dir, "management-api.env");
    writeFileSync(runtime, "CUSTOM_RUNTIME=keep\n", { mode: 0o644 });

    const missing = runBash(
      'source install.sh; unset JWT_SECRET; persist_service_container_runtime_env',
      { SUPACLOUD_MANAGEMENT_ENV_FILE: runtime },
    );
    expect(missing.status).not.toBe(0);
    expect(readFileSync(runtime, "utf8")).toBe("CUSTOM_RUNTIME=keep\n");

    const merged = runBash(
      'source install.sh; JWT_SECRET="jwt-without-fallback"; persist_service_container_runtime_env',
      { SUPACLOUD_MANAGEMENT_ENV_FILE: runtime },
    );
    expect(merged.status, merged.stderr).toBe(0);
    const contents = readFileSync(runtime, "utf8");
    expect(contents).toContain("CUSTOM_RUNTIME=keep");
    expect(contents).toContain('REALTIME_API_SECRET="jwt-without-fallback"');
    expect(statSync(runtime).mode & 0o777).toBe(0o600);
  });

  test("postgres password becomes a SCRAM verifier without entering su -c, SQL, or process arguments", () => {
    const dir = makeTempDir();
    const argv = join(dir, "argv.txt");
    const stdin = join(dir, "stdin.txt");
    const password = "pa'ss word";

    const result = runBash(
      [
        "source install.sh",
        'sudo() { printf "%s\\n" "$*" > "$ARGV_FILE"; cat > "$STDIN_FILE"; }',
        "export -f sudo",
        'set_postgres_role_password "$POSTGRES_PASSWORD"',
      ].join("; "),
      { ARGV_FILE: argv, STDIN_FILE: stdin, POSTGRES_PASSWORD: password },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(argv, "utf8")).not.toContain(password);
    expect(readFileSync(argv, "utf8")).not.toContain("su -");
    expect(readFileSync(argv, "utf8")).toContain("-f -");
    expect(readFileSync(stdin, "utf8")).not.toContain(password);
    expect(readFileSync(stdin, "utf8")).toContain("SCRAM-SHA-256$4096:");
    expect(readFileSync(stdin, "utf8")).toContain(":'postgres_verifier'");
  });

  test("generated PostgreSQL SCRAM verifier matches the original password including an apostrophe", () => {
    const password = "pa'ss word";
    const result = runBash(
      'source scripts/lib/install_config.sh; printf %s "$PASSWORD" | supacloud_postgres_scram_verifier',
      { PASSWORD: password },
    );
    expect(result.status, result.stderr).toBe(0);
    const match = result.stdout.match(/^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/);
    expect(match).not.toBeNull();
    const [, iterations, saltText, storedText, serverText] = match!;
    const salted = pbkdf2Sync(password, Buffer.from(saltText, "base64"), Number(iterations), 32, "sha256");
    const clientKey = createHmac("sha256", salted).update("Client Key").digest();
    const storedKey = createHash("sha256").update(clientKey).digest("base64");
    const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
    expect(storedText).toBe(storedKey);
    expect(serverText).toBe(serverKey);
  });

  test("management database URLs percent-encode reserved password characters through stdin", () => {
    const result = runBash(
      'source scripts/lib/install_config.sh; printf %s "$PASSWORD" | supacloud_urlencode_stdin',
      { PASSWORD: "pa@ss:/?#[]" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("pa%40ss%3A%2F%3F%23%5B%5D");
  });

  test("JWT HS256 signing reads the secret through stdin and matches the expected signature", () => {
    const secret = "jwt-secret-with-an-apostrophe-'";
    const message = "header.payload";
    const result = runBash(
      'source scripts/lib/install_config.sh; supacloud_hs256_signature "$SECRET" "$MESSAGE"',
      { SECRET: secret, MESSAGE: message },
    );
    expect(result.status, result.stderr).toBe(0);
    const expected = createHmac("sha256", secret).update(message).digest("base64url");
    expect(result.stdout).toBe(expected);
  });

  test("runtime secret resolution reuses an existing encrypted-data key", () => {
    const dir = makeTempDir();
    const runtimeEnv = join(dir, "management-api.env");
    writeFileSync(runtimeEnv, "SECRETS_ENCRYPTION_KEY=existing-encryption-key\n");

    const result = runBash(
      'source scripts/lib/install_config.sh && supacloud_stable_secret "$RUNTIME_ENV" SECRETS_ENCRYPTION_KEY generated-key',
      { RUNTIME_ENV: runtimeEnv },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("existing-encryption-key");
  });

  test("installer passes the old master token only to an upgrade migration and fails closed", () => {
    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");
    const installFunction = installer.slice(
      installer.indexOf("install_management_api() {"),
      installer.indexOf("deploy_web_console_tar_atomic()"),
    );
    expect(installer).toContain('migration_legacy_encryption_key="$MASTER_TOKEN"');
    expect(installer).toContain('LEGACY_SECRETS_ENCRYPTION_KEY="$migration_legacy_encryption_key" "$staged_management_binary" --init-db');
    expect(installer).toContain('supacloud_secret_rotation_checkpoint_status "$SECRETS_ENCRYPTION_KEY"');
    expect(installer).toContain('abort_management_install_transaction "$management_transaction_dir"');
    expect(installer).toContain('abort_management_install_transaction "$management_transaction_dir" "$management_service_was_active" true 1');
    expect(installer).not.toContain("--init-db 2>/dev/null || log_warn");
    expect(installer).toContain('existing_runtime_encryption_key="$(supacloud_env_value "$MANAGEMENT_ENV_FILE" SECRETS_ENCRYPTION_KEY)"');
    expect(installFunction.indexOf("supacloud_stop_service_for_migration")).toBeLessThan(
      installFunction.indexOf('supacloud_write_service_env_pairs "$MANAGEMENT_ENV_FILE"'),
    );
    expect(installFunction.indexOf('"$staged_management_binary" --init-db')).toBeLessThan(
      installFunction.indexOf('mv -f "$staged_management_binary" "$BIN_TARGET"'),
    );
  });

  test("management installer resolves TLS settings in its own scope", () => {
    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");
    const installFunction = installer.slice(
      installer.indexOf("install_management_api() {"),
      installer.indexOf("deploy_web_console_tar_atomic()"),
    );
    expect(installFunction).toContain(
      'local edge_tls_ca_file="${SUPACLOUD_EDGE_TLS_CA_FILE:-$(supacloud_env_value "$MANAGEMENT_ENV_FILE" SUPACLOUD_EDGE_TLS_CA_FILE)}"',
    );
    expect(installFunction).toContain(
      'local edge_tls_insecure_skip_verify="${SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY:-$(supacloud_env_value "$MANAGEMENT_ENV_FILE" SUPACLOUD_EDGE_TLS_INSECURE_SKIP_VERIFY)}"',
    );
  });

  test("installer snapshots restore file contents, permissions, and prior absence", () => {
    const dir = makeTempDir();
    const existing = join(dir, "management-api.env");
    const absent = join(dir, "missing.env");
    const existingSnapshot = join(dir, "existing-snapshot");
    const absentSnapshot = join(dir, "absent-snapshot");
    writeFileSync(existing, "OLD=value\n", { mode: 0o640 });

    const result = runBash([
      "source scripts/lib/install_config.sh",
      'supacloud_capture_file_snapshot "$EXISTING" "$EXISTING_SNAPSHOT"',
      'supacloud_capture_file_snapshot "$ABSENT" "$ABSENT_SNAPSHOT"',
      'printf "NEW=value\\n" > "$EXISTING"',
      'printf "created\\n" > "$ABSENT"',
      'supacloud_restore_file_snapshot "$EXISTING" "$EXISTING_SNAPSHOT"',
      'supacloud_restore_file_snapshot "$ABSENT" "$ABSENT_SNAPSHOT"',
    ].join(" && "), {
      EXISTING: existing,
      ABSENT: absent,
      EXISTING_SNAPSHOT: existingSnapshot,
      ABSENT_SNAPSHOT: absentSnapshot,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(existing, "utf8")).toBe("OLD=value\n");
    expect(statSync(existing).mode & 0o777).toBe(0o640);
    expect(() => statSync(absent)).toThrow();
  });

  test("installer snapshots restore runtime directories", () => {
    const dir = makeTempDir();
    const runtime = join(dir, "runtime");
    const snapshot = join(dir, "snapshot");
    mkdirSync(runtime);
    writeFileSync(join(runtime, "server.ts"), "old\n");

    const result = runBash([
      "source scripts/lib/install_config.sh",
      'supacloud_capture_directory_snapshot "$RUNTIME" "$SNAPSHOT"',
      'printf "new\\n" > "$RUNTIME/server.ts"',
      'printf "extra\\n" > "$RUNTIME/extra.ts"',
      'supacloud_restore_directory_snapshot "$RUNTIME" "$SNAPSHOT"',
    ].join(" && "), { RUNTIME: runtime, SNAPSHOT: snapshot });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(runtime, "server.ts"), "utf8")).toBe("old\n");
    expect(() => statSync(join(runtime, "extra.ts"))).toThrow();
  });

  test("management Edge readiness restarts external mode and uses the persisted port", () => {
    const dir = makeTempDir();
    const runtimeEnv = join(dir, "management-api.env");
    const externalCalls = join(dir, "external-calls");
    const external = runBash([
      "source install.sh",
      'systemctl() { printf "systemctl:%s\\n" "$*" >> "$CALLS"; return 1; }',
      'log_warn() { printf "warn:%s\\n" "$*" >> "$CALLS"; }',
      'supacloud_wait_http_health() { printf "health:%s\\n" "$1" >> "$CALLS"; return 0; }',
      "ensure_management_edge_runtime_ready external",
    ].join("; "), { CALLS: externalCalls });

    expect(external.status, external.stderr).toBe(0);
    expect(readFileSync(externalCalls, "utf8")).toBe([
      "systemctl:enable --now supacloud-edge-runtime",
      "warn:systemctl enable --now supacloud-edge-runtime returned non-zero; deferring readiness to the health check",
      "health:http://127.0.0.1:9005/health",
      "",
    ].join("\n"));

    const embeddedCalls = join(dir, "embedded-calls");
    const embedded = runBash([
      "source install.sh",
      'systemctl() { printf "unexpected-systemctl\\n" >> "$CALLS"; }',
      'supacloud_wait_http_health() { printf "health:%s\\n" "$1" >> "$CALLS"; return 7; }',
      "ensure_management_edge_runtime_ready embedded",
    ].join("; "), { CALLS: embeddedCalls });

    expect(embedded.status).toBe(7);
    expect(readFileSync(embeddedCalls, "utf8")).toBe("health:http://127.0.0.1:9005/health\n");

    writeFileSync(runtimeEnv, "EDGE_RUNTIME_PORT=9123\n");
    const customCalls = join(dir, "custom-calls");
    const custom = runBash([
      "source install.sh",
      'supacloud_wait_http_health() { printf "health:%s\\n" "$1" >> "$CALLS"; }',
      "ensure_management_edge_runtime_ready embedded",
    ].join("; "), {
      CALLS: customCalls,
      SUPACLOUD_MANAGEMENT_ENV_FILE: runtimeEnv,
    });

    expect(custom.status, custom.stderr).toBe(0);
    expect(readFileSync(customCalls, "utf8")).toBe("health:http://127.0.0.1:9123/health\n");

    const identityCalls = join(dir, "identity-calls");
    const digest = "a".repeat(64);
    const attested = runBash([
      "source install.sh",
      `supacloud_read_edge_runtime_source_identity() { printf '0.18.7\\t${digest}'; }`,
      'supacloud_wait_edge_runtime_source_identity() { printf "identity:%s:%s:%s\\n" "$1" "$2" "$3" >> "$CALLS"; }',
      "ensure_management_edge_runtime_ready embedded required",
    ].join("; "), { CALLS: identityCalls });
    expect(attested.status, attested.stderr).toBe(0);
    expect(readFileSync(identityCalls, "utf8")).toBe(
      `identity:http://127.0.0.1:9005/health:0.18.7:${digest}\n`,
    );

    const compiledCalls = join(dir, "compiled-calls");
    const edgeEnv = join(dir, "edge-runtime.env");
    writeFileSync(edgeEnv, "SUPACLOUD_EDGE_RUNTIME_IDENTITY_MODE=compiled\n");
    const compiled = runBash([
      "source install.sh",
      'systemctl() { return 0; }',
      `supacloud_read_edge_runtime_source_identity() { printf '0.18.7\\t${digest}'; }`,
      'supacloud_wait_edge_runtime_compiled_identity() { printf "compiled:%s:%s\\n" "$1" "$2" >> "$CALLS"; }',
      "ensure_management_edge_runtime_ready external required",
    ].join("; "), {
      CALLS: compiledCalls,
      SUPACLOUD_EDGE_RUNTIME_ENV_FILE: edgeEnv,
    });
    expect(compiled.status, compiled.stderr).toBe(0);
    expect(readFileSync(compiledCalls, "utf8")).toBe(
      "compiled:http://127.0.0.1:9005/health:0.18.7\n",
    );

    const missingIdentity = runBash([
      "source install.sh",
      "supacloud_read_edge_runtime_source_identity() { return 1; }",
      "ensure_management_edge_runtime_ready embedded required",
    ].join("; "));
    expect(missingIdentity.status).not.toBe(0);
    expect(missingIdentity.stdout).toContain("health identity is unavailable");
  });

  test("management Edge source transaction removes stale files and restores the prior tree", () => {
    const dir = makeTempDir();
    const sourceDir = join(dir, "source");
    const targetDir = join(dir, "target");
    const managementTransaction = join(dir, "management-transaction");
    const fakeBin = join(dir, "bin");
    mkdirSync(sourceDir);
    mkdirSync(targetDir);
    mkdirSync(managementTransaction);
    mkdirSync(fakeBin);
    writeFileSync(join(sourceDir, "package.json"), JSON.stringify({
      name: "@supacloud/edge-runtime",
      version: "1.2.3",
    }));
    writeFileSync(join(sourceDir, "server.ts"), "new-runtime\n");
    writeFileSync(join(targetDir, "server.ts"), "old-runtime\n");
    writeFileSync(join(targetDir, "removed.ts"), "old-only\n");
    writeFileSync(join(fakeBin, "bun"), [
      "#!/usr/bin/env bash",
      "mkdir -p node_modules",
      "printf 'installed\\n' > node_modules/installed.txt",
      "",
    ].join("\n"), { mode: 0o755 });

    const result = runBash([
      "source install.sh",
      'configure_edge_runtime_source_access() { chmod -R g-w,g+rX "$1"; }',
      'capture_management_edge_runtime_source_state "$MANAGEMENT_TRANSACTION/edge-source-prior"',
      'prepare_management_edge_runtime_source "$MANAGEMENT_TRANSACTION"',
      'activate_management_edge_runtime_source "$MANAGEMENT_TRANSACTION"',
      'test "$(cat "$EDGE_RUNTIME_SOURCE_DIR/server.ts")" = new-runtime',
      'test ! -e "$EDGE_RUNTIME_SOURCE_DIR/removed.ts"',
      'test -f "$EDGE_RUNTIME_SOURCE_DIR/.supacloud-source-identity.json"',
      'rollback_management_edge_runtime_source "$MANAGEMENT_TRANSACTION"',
      'verify_recovered_management_edge_runtime_source "$MANAGEMENT_TRANSACTION"',
      'test "$(cat "$EDGE_RUNTIME_SOURCE_DIR/server.ts")" = old-runtime',
      'test -f "$EDGE_RUNTIME_SOURCE_DIR/removed.ts"',
    ].join(" && "), {
      PATH: `${fakeBin}:${process.env.PATH}`,
      MANAGEMENT_TRANSACTION: managementTransaction,
      SUPACLOUD_EDGE_RUNTIME_SOURCE_INPUT_DIR: sourceDir,
      SUPACLOUD_EDGE_RUNTIME_SOURCE_DIR: targetDir,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(targetDir, "server.ts"), "utf8")).toBe("old-runtime\n");
    expect(readFileSync(join(targetDir, "removed.ts"), "utf8")).toBe("old-only\n");
  });

  test("management Edge release staging fails closed when the lockfile install fails", () => {
    const dir = makeTempDir();
    const sourceDir = join(dir, "source");
    const targetDir = join(dir, "target");
    const managementTransaction = join(dir, "management-transaction");
    const fakeBin = join(dir, "bin");
    const calls = join(dir, "bun-calls");
    mkdirSync(sourceDir);
    mkdirSync(managementTransaction);
    mkdirSync(fakeBin);
    writeFileSync(join(sourceDir, "package.json"), JSON.stringify({
      name: "@supacloud/edge-runtime",
      version: "1.2.3",
    }));
    writeFileSync(join(sourceDir, "bun.lock"), "{}\n");
    writeFileSync(join(sourceDir, "server.ts"), "runtime\n");
    writeFileSync(join(fakeBin, "bun"), [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$CALLS"',
      '[[ "$*" != *"--frozen-lockfile"* ]]',
      "",
    ].join("\n"), { mode: 0o755 });

    const result = runBash([
      "source install.sh",
      "supacloud_resolve_artifact_policy",
      'prepare_management_edge_runtime_source "$MANAGEMENT_TRANSACTION"',
    ].join(" && "), {
      PATH: `${fakeBin}:${process.env.PATH}`,
      CALLS: calls,
      MANAGEMENT_TRANSACTION: managementTransaction,
      SUPACLOUD_SETUP_ARTIFACT_MODE: "release",
      SUPACLOUD_EDGE_RUNTIME_SOURCE_INPUT_DIR: sourceDir,
      SUPACLOUD_EDGE_RUNTIME_SOURCE_DIR: targetDir,
    });

    expect(result.status).not.toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "install --frozen-lockfile",
    ]);
    expect(result.stdout).toContain("do not match the lockfile");
    expect(existsSync(targetDir)).toBe(false);
  });

  test("local Web Console deployment atomically replaces the complete prior build", () => {
    const dir = makeTempDir();
    const sourceDir = join(dir, "source");
    const targetDir = join(dir, "current");
    mkdirSync(sourceDir);
    mkdirSync(targetDir);
    writeFileSync(join(sourceDir, "index.html"), "new-index\n");
    writeFileSync(join(sourceDir, "new.js"), "new-asset\n");
    writeFileSync(join(targetDir, "index.html"), "old-index\n");
    writeFileSync(join(targetDir, "stale.js"), "stale-asset\n");

    const deployed = runBash(
      'source install.sh; deploy_web_console_directory_atomic "$SOURCE" "$TARGET"',
      { SOURCE: sourceDir, TARGET: targetDir },
    );

    expect(deployed.status, deployed.stderr).toBe(0);
    expect(readFileSync(join(targetDir, "index.html"), "utf8")).toBe("new-index\n");
    expect(readFileSync(join(targetDir, "new.js"), "utf8")).toBe("new-asset\n");
    expect(() => statSync(join(targetDir, "stale.js"))).toThrow();

    rmSync(join(sourceDir, "index.html"));
    const rejected = runBash(
      'source install.sh; deploy_web_console_directory_atomic "$SOURCE" "$TARGET"',
      { SOURCE: sourceDir, TARGET: targetDir },
    );
    expect(rejected.status).not.toBe(0);
    expect(readFileSync(join(targetDir, "index.html"), "utf8")).toBe("new-index\n");
  });

  test("local Web Console deployment replaces a managed historical release symlink", () => {
    const dir = makeTempDir();
    const sourceDir = join(dir, "source");
    const releasesDir = join(dir, "releases");
    const priorRelease = join(releasesDir, "management-api-v0.66.0");
    const targetDir = join(dir, "current");
    mkdirSync(sourceDir);
    mkdirSync(releasesDir);
    mkdirSync(priorRelease);
    writeFileSync(join(sourceDir, "index.html"), "new-index\n");
    writeFileSync(join(priorRelease, "index.html"), "old-index\n");
    symlinkSync(priorRelease, targetDir);

    const deployed = runBash(
      'source install.sh; deploy_web_console_directory_atomic "$SOURCE" "$TARGET"',
      { SOURCE: sourceDir, TARGET: targetDir },
    );

    expect(deployed.status, deployed.stderr).toBe(0);
    expect(lstatSync(targetDir).isDirectory()).toBe(true);
    expect(readFileSync(join(targetDir, "index.html"), "utf8")).toBe("new-index\n");
    expect(readFileSync(join(priorRelease, "index.html"), "utf8")).toBe("old-index\n");
  });

  test("local Web Console deployment rejects a symlink outside managed releases", () => {
    const dir = makeTempDir();
    const sourceDir = join(dir, "source");
    const releasesDir = join(dir, "releases");
    const outsideRelease = join(dir, "outside-release");
    const targetDir = join(dir, "current");
    mkdirSync(sourceDir);
    mkdirSync(releasesDir);
    mkdirSync(outsideRelease);
    writeFileSync(join(sourceDir, "index.html"), "new-index\n");
    writeFileSync(join(outsideRelease, "index.html"), "old-index\n");
    symlinkSync(outsideRelease, targetDir);

    const rejected = runBash(
      'source install.sh; deploy_web_console_directory_atomic "$SOURCE" "$TARGET"',
      { SOURCE: sourceDir, TARGET: targetDir },
    );

    expect(rejected.status).not.toBe(0);
    expect(lstatSync(targetDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(targetDir, "index.html"), "utf8")).toBe("old-index\n");
  });

  test("installer grants the dedicated runtime group read-only source access", () => {
    const dir = makeTempDir();
    const calls = join(dir, "calls");
    const sourceDir = join(dir, "edge-runtime");
    mkdirSync(sourceDir);

    const configured = runBash([
      "source install.sh",
      'chgrp() { printf "chgrp:%s\\n" "$*" >> "$CALLS"; }',
      'chmod() { printf "chmod:%s\\n" "$*" >> "$CALLS"; }',
      'configure_edge_runtime_source_access "$SOURCE_DIR"',
    ].join("; "), { CALLS: calls, SOURCE_DIR: sourceDir });

    expect(configured.status, configured.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe([
      `chmod:-R g-w,g+rX ${sourceDir}`,
      `chgrp:-R supacloud-edge ${sourceDir}`,
      "",
    ].join("\n"));
  });

  test("management Edge mode uses the persisted service environment and fails closed", () => {
    const dir = makeTempDir();
    const runtimeEnv = join(dir, "management-api.env");
    const resolveMode = () => runBash(
      "source install.sh; management_edge_runtime_mode",
      { SUPACLOUD_MANAGEMENT_ENV_FILE: runtimeEnv },
    );

    writeFileSync(runtimeEnv, "EDGE_RUNTIME_MODE=external\n");
    expect(resolveMode().stdout).toBe("external");
    writeFileSync(runtimeEnv, "OTHER=value\n");
    expect(resolveMode().stdout).toBe("embedded");
    writeFileSync(runtimeEnv, "EDGE_RUNTIME_MODE=invalid\n");
    expect(resolveMode().status).not.toBe(0);
  });

  test("management install preflight fails closed when privilege tools are unavailable", () => {
    const dir = makeTempDir();
    const emptyBin = join(dir, "empty-bin");
    mkdirSync(emptyBin);

    const missing = runBash(
      'source install.sh; PATH="$EMPTY_BIN"; ensure_management_privilege_tools_available',
      { EMPTY_BIN: emptyBin },
    );
    expect(missing.status).not.toBe(0);
    expect(missing.stdout).toContain("requires setpriv");

    writeFileSync(join(emptyBin, "setpriv"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const missingId = runBash(
      'source install.sh; PATH="$EMPTY_BIN"; ensure_management_privilege_tools_available',
      { EMPTY_BIN: emptyBin },
    );
    expect(missingId.status).not.toBe(0);
    expect(missingId.stdout).toContain("requires id");

    writeFileSync(join(emptyBin, "id"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    const available = runBash(
      'source install.sh; PATH="$EMPTY_BIN"; ensure_management_privilege_tools_available',
      { EMPTY_BIN: emptyBin },
    );
    expect(available.status, available.stderr).toBe(0);
  });

  test("management recovery reconciles the privilege drop-in when the committed mode changes", () => {
    const runRecovery = (runtimeMode: "embedded" | "external", priorDropIn: "present" | "absent") => {
      const dir = makeTempDir();
      const runtimeEnv = join(dir, "management-api.env");
      const edgeRuntimeEnv = join(dir, "edge-runtime.env");
      const privilegeDropIn = join(dir, "supacloud.service.d", "50-embedded-edge-privilege.conf");
      writeFileSync(runtimeEnv, `EDGE_RUNTIME_MODE=${runtimeMode}\n`);

      const recovery = runBash([
        "source install.sh",
        'supacloud_restore_file_snapshot() { if [[ "$1" == "$MANAGEMENT_EDGE_PRIVILEGE_DROPIN" ]]; then if [[ "$PRIOR_DROPIN" == "present" ]]; then install -D -m 0644 /dev/stdin "$1" <<< "old-drop-in"; else rm -f "$1"; fi; fi; return 0; }',
        'systemctl() { [[ "$1" == "is-active" ]] && return 1; return 0; }',
        "supacloud_wait_http_health() { return 0; }",
        'recover_management_api_install "$SNAPSHOT" true true',
      ].join("; "), {
        PRIOR_DROPIN: priorDropIn,
        SNAPSHOT: join(dir, "snapshot"),
        SUPACLOUD_MANAGEMENT_ENV_FILE: runtimeEnv,
        SUPACLOUD_EDGE_RUNTIME_ENV_FILE: edgeRuntimeEnv,
        SUPACLOUD_EMBEDDED_EDGE_PRIVILEGE_DROPIN: privilegeDropIn,
      });

      expect(recovery.status, recovery.stderr).toBe(0);
      return privilegeDropIn;
    };

    const externalDropIn = runRecovery("external", "present");
    expect(() => statSync(externalDropIn)).toThrow();

    const embeddedDropIn = runRecovery("embedded", "absent");
    expect(readFileSync(embeddedDropIn, "utf8")).toContain("CAP_SETGID CAP_SETUID");
  });

  test("management recovery disables an installed external runtime before restarting embedded mode", () => {
    const dir = makeTempDir();
    const runtimeEnv = join(dir, "management-api.env");
    const edgeRuntimeEnv = join(dir, "edge-runtime.env");
    const privilegeDropIn = join(dir, "supacloud.service.d", "50-embedded-edge-privilege.conf");
    const calls = join(dir, "calls");
    writeFileSync(runtimeEnv, "EDGE_RUNTIME_MODE=embedded\n");

    const recovery = runBash([
      "source install.sh",
      'supacloud_restore_file_snapshot() { return 0; }',
      'systemctl() { printf "systemctl:%s\\n" "$*" >> "$CALLS"; case "$1" in is-active) return 1 ;; list-unit-files) printf "supacloud-edge-runtime.service disabled\\n" ;; esac; }',
      'supacloud_wait_http_health() { printf "health:%s\\n" "$1" >> "$CALLS"; }',
      'recover_management_api_install "$SNAPSHOT" true true',
    ].join("; "), {
      CALLS: calls,
      SNAPSHOT: join(dir, "snapshot"),
      SUPACLOUD_MANAGEMENT_ENV_FILE: runtimeEnv,
      SUPACLOUD_EDGE_RUNTIME_ENV_FILE: edgeRuntimeEnv,
      SUPACLOUD_EMBEDDED_EDGE_PRIVILEGE_DROPIN: privilegeDropIn,
    });

    expect(recovery.status, recovery.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).toContain([
      "systemctl:daemon-reload",
      "systemctl:list-unit-files supacloud-edge-runtime.service --no-legend",
      "systemctl:disable --now supacloud-edge-runtime",
      "systemctl:start supacloud",
      "health:http://127.0.0.1:9090/health",
      "health:http://127.0.0.1:9005/health",
      "",
    ].join("\n"));
    expect(readFileSync(calls, "utf8").indexOf("systemctl:disable --now supacloud-edge-runtime"))
      .toBeLessThan(readFileSync(calls, "utf8").indexOf("systemctl:start supacloud"));
  });

  test("management recovery enables external mode after restoring the management service", () => {
    const dir = makeTempDir();
    const runtimeEnv = join(dir, "management-api.env");
    const edgeRuntimeEnv = join(dir, "edge-runtime.env");
    const privilegeDropIn = join(dir, "supacloud.service.d", "50-embedded-edge-privilege.conf");
    const calls = join(dir, "calls");
    const edgeState = join(dir, "edge-state");
    const snapshot = join(dir, "snapshot");
    mkdirSync(join(snapshot, "edge-service-prior"), { recursive: true });
    writeFileSync(runtimeEnv, "EDGE_RUNTIME_MODE=external\n");
    writeFileSync(join(snapshot, "edge-service-prior/state"), "active\n");
    writeFileSync(join(snapshot, "edge-service-prior/enabled"), "enabled\n");
    writeFileSync(edgeState, "inactive\n");

    const recovery = runBash([
      "source install.sh",
      'supacloud_restore_file_snapshot() { return 0; }',
      'systemctl() { printf "systemctl:%s\\n" "$*" >> "$CALLS"; if [[ "$1" == is-active ]]; then [[ "$3" == supacloud-edge-runtime && "$(cat "$EDGE_STATE")" == active ]]; return; fi; if [[ "$1:$3" == enable:supacloud-edge-runtime ]]; then printf active > "$EDGE_STATE"; fi; return 0; }',
      'supacloud_wait_http_health() { printf "health:%s\\n" "$1" >> "$CALLS"; }',
      'recover_management_api_install "$SNAPSHOT" true true',
    ].join("; "), {
      CALLS: calls,
      EDGE_STATE: edgeState,
      SNAPSHOT: snapshot,
      SUPACLOUD_MANAGEMENT_ENV_FILE: runtimeEnv,
      SUPACLOUD_EDGE_RUNTIME_ENV_FILE: edgeRuntimeEnv,
      SUPACLOUD_EMBEDDED_EDGE_PRIVILEGE_DROPIN: privilegeDropIn,
    });

    expect(recovery.status, recovery.stderr).toBe(0);
    const recoveryCalls = readFileSync(calls, "utf8");
    expect(recoveryCalls).toContain("systemctl:enable --now supacloud-edge-runtime");
    expect(recoveryCalls.indexOf("systemctl:start supacloud"))
      .toBeLessThan(recoveryCalls.indexOf("systemctl:enable --now supacloud-edge-runtime"));
  });

  test("management recovery keeps an active but disabled external runtime disabled", () => {
    const dir = makeTempDir();
    const runtimeEnv = join(dir, "management-api.env");
    const edgeRuntimeEnv = join(dir, "edge-runtime.env");
    const privilegeDropIn = join(dir, "supacloud.service.d", "50-embedded-edge-privilege.conf");
    const calls = join(dir, "calls");
    const edgeState = join(dir, "edge-state");
    const snapshot = join(dir, "snapshot");
    mkdirSync(join(snapshot, "edge-service-prior"), { recursive: true });
    writeFileSync(runtimeEnv, "EDGE_RUNTIME_MODE=external\n");
    writeFileSync(join(snapshot, "edge-service-prior/state"), "active\n");
    writeFileSync(join(snapshot, "edge-service-prior/enabled"), "disabled\n");
    writeFileSync(edgeState, "inactive\n");

    const recovery = runBash([
      "source install.sh",
      'supacloud_restore_file_snapshot() { return 0; }',
      'systemctl() { printf "systemctl:%s\\n" "$*" >> "$CALLS"; if [[ "$1" == is-active ]]; then [[ "$3" == supacloud-edge-runtime && "$(cat "$EDGE_STATE")" == active ]]; return; fi; if [[ "$1:$2" == start:supacloud-edge-runtime ]]; then printf active > "$EDGE_STATE"; fi; return 0; }',
      'supacloud_wait_http_health() { printf "health:%s\\n" "$1" >> "$CALLS"; }',
      'recover_management_api_install "$SNAPSHOT" true true',
    ].join("; "), {
      CALLS: calls,
      EDGE_STATE: edgeState,
      SNAPSHOT: snapshot,
      SUPACLOUD_MANAGEMENT_ENV_FILE: runtimeEnv,
      SUPACLOUD_EDGE_RUNTIME_ENV_FILE: edgeRuntimeEnv,
      SUPACLOUD_EMBEDDED_EDGE_PRIVILEGE_DROPIN: privilegeDropIn,
    });

    expect(recovery.status, recovery.stderr).toBe(0);
    const recoveryCalls = readFileSync(calls, "utf8");
    expect(recoveryCalls).toContain("systemctl:start supacloud-edge-runtime");
    expect(recoveryCalls).not.toContain("systemctl:enable --now supacloud-edge-runtime");
  });

  test("management recovery keeps a previously inactive external runtime stopped", () => {
    const dir = makeTempDir();
    const runtimeEnv = join(dir, "management-api.env");
    const edgeRuntimeEnv = join(dir, "edge-runtime.env");
    const privilegeDropIn = join(dir, "supacloud.service.d", "50-embedded-edge-privilege.conf");
    const calls = join(dir, "calls");
    const edgeState = join(dir, "edge-state");
    const snapshot = join(dir, "snapshot");
    mkdirSync(join(snapshot, "edge-service-prior"), { recursive: true });
    writeFileSync(runtimeEnv, "EDGE_RUNTIME_MODE=external\n");
    writeFileSync(join(snapshot, "edge-service-prior/state"), "inactive\n");
    writeFileSync(join(snapshot, "edge-service-prior/enabled"), "disabled\n");
    writeFileSync(edgeState, "active\n");

    const recovery = runBash([
      "source install.sh",
      'supacloud_restore_file_snapshot() { return 0; }',
      'systemctl() { printf "systemctl:%s\\n" "$*" >> "$CALLS"; if [[ "$1" == is-active ]]; then [[ "$3" == supacloud-edge-runtime && "$(cat "$EDGE_STATE")" == active ]]; return; fi; if [[ "$1:$2" == stop:supacloud-edge-runtime ]]; then printf inactive > "$EDGE_STATE"; fi; return 0; }',
      'recover_management_api_install "$SNAPSHOT" false true',
    ].join("; "), {
      CALLS: calls,
      EDGE_STATE: edgeState,
      SNAPSHOT: snapshot,
      SUPACLOUD_MANAGEMENT_ENV_FILE: runtimeEnv,
      SUPACLOUD_EDGE_RUNTIME_ENV_FILE: edgeRuntimeEnv,
      SUPACLOUD_EMBEDDED_EDGE_PRIVILEGE_DROPIN: privilegeDropIn,
    });

    expect(recovery.status, recovery.stderr).toBe(0);
    expect(readFileSync(edgeState, "utf8")).toBe("inactive");
    expect(readFileSync(calls, "utf8")).not.toContain("enable --now supacloud-edge-runtime");
  });

  test("pgredis transaction restores the previous data plane after a later install failure", () => {
    const dir = makeTempDir();
    const fakeBin = join(dir, "bin");
    const binary = join(dir, "pgredis-runtime");
    const runtimeEnv = join(dir, "pgredis-runtime.env");
    const unit = join(dir, "pgredis-runtime.service");
    const sourceDir = join(dir, "source");
    const serviceState = join(dir, "service-state");
    const enabledState = join(dir, "enabled-state");
    mkdirSync(fakeBin);
    mkdirSync(sourceDir);
    writeFileSync(binary, "old-binary\n", { mode: 0o755 });
    writeFileSync(runtimeEnv, "OLD_TOKEN=one\n", { mode: 0o600 });
    writeFileSync(unit, "old-unit\n");
    writeFileSync(join(sourceDir, "server.ts"), "old-source\n");
    writeFileSync(serviceState, "active");
    writeFileSync(enabledState, "enabled");
    writeFileSync(join(fakeBin, "curl"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(fakeBin, "systemctl"), [
      "#!/usr/bin/env bash",
      'case "$1" in',
      '  is-active) [[ "$(cat "$SERVICE_STATE")" == active ]] ;;',
      '  is-enabled) [[ "$(cat "$ENABLED_STATE")" == enabled ]] ;;',
      '  stop) printf inactive > "$SERVICE_STATE" ;;',
      '  start) printf active > "$SERVICE_STATE" ;;',
      '  enable) printf enabled > "$ENABLED_STATE" ;;',
      '  disable) printf disabled > "$ENABLED_STATE" ;;',
      '  daemon-reload) exit 0 ;;',
      "esac",
    ].join("\n"), { mode: 0o755 });

    const result = runBash([
      "source install.sh",
      "begin_pgredis_install_transaction",
      'printf "new-binary\\n" > "$PGREDIS_RUNTIME_BIN_FILE"',
      'printf "NEW_TOKEN=two\\n" > "$PGREDIS_RUNTIME_ENV_FILE"',
      'printf "new-unit\\n" > "$PGREDIS_RUNTIME_UNIT_FILE"',
      'printf "new-source\\n" > "$PGREDIS_RUNTIME_SOURCE_DIR/server.ts"',
      "rollback_pgredis_install_transaction",
    ].join(" && "), {
      PATH: `${fakeBin}:${process.env.PATH}`,
      SERVICE_STATE: serviceState,
      ENABLED_STATE: enabledState,
      SUPACLOUD_PGREDIS_RUNTIME_BIN_FILE: binary,
      SUPACLOUD_PGREDIS_RUNTIME_ENV_FILE: runtimeEnv,
      SUPACLOUD_PGREDIS_RUNTIME_UNIT_FILE: unit,
      SUPACLOUD_PGREDIS_RUNTIME_SOURCE_DIR: sourceDir,
      SUPACLOUD_PGREDIS_TRANSACTION_PARENT: dir,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(binary, "utf8")).toBe("old-binary\n");
    expect(readFileSync(runtimeEnv, "utf8")).toBe("OLD_TOKEN=one\n");
    expect(readFileSync(unit, "utf8")).toBe("old-unit\n");
    expect(readFileSync(join(sourceDir, "server.ts"), "utf8")).toBe("old-source\n");
    expect(readFileSync(serviceState, "utf8")).toBe("active");
    expect(readFileSync(enabledState, "utf8")).toBe("enabled");
  });

  test("pgredis transaction restores the previous data plane on SIGTERM", () => {
    const dir = makeTempDir();
    const fakeBin = join(dir, "bin");
    const binary = join(dir, "pgredis-runtime");
    const runtimeEnv = join(dir, "pgredis-runtime.env");
    const unit = join(dir, "pgredis-runtime.service");
    const sourceDir = join(dir, "source");
    mkdirSync(fakeBin);
    mkdirSync(sourceDir);
    writeFileSync(binary, "old-binary\n", { mode: 0o755 });
    writeFileSync(runtimeEnv, "OLD_TOKEN=one\n", { mode: 0o600 });
    writeFileSync(unit, "old-unit\n");
    writeFileSync(join(sourceDir, "server.ts"), "old-source\n");
    writeFileSync(join(fakeBin, "systemctl"), [
      "#!/usr/bin/env bash",
      'case "$1" in',
      '  is-active|is-enabled) exit 1 ;;',
      '  daemon-reload|disable|stop) exit 0 ;;',
      "esac",
    ].join("\n"), { mode: 0o755 });

    const result = runBash([
      "source install.sh",
      "begin_pgredis_install_transaction",
      'printf "new-binary\\n" > "$PGREDIS_RUNTIME_BIN_FILE"',
      'printf "NEW_TOKEN=two\\n" > "$PGREDIS_RUNTIME_ENV_FILE"',
      'trap \'abort_pgredis_install_transaction 143\' TERM',
      'kill -TERM $$',
    ].join(" && "), {
      PATH: `${fakeBin}:${process.env.PATH}`,
      SUPACLOUD_PGREDIS_RUNTIME_BIN_FILE: binary,
      SUPACLOUD_PGREDIS_RUNTIME_ENV_FILE: runtimeEnv,
      SUPACLOUD_PGREDIS_RUNTIME_UNIT_FILE: unit,
      SUPACLOUD_PGREDIS_RUNTIME_SOURCE_DIR: sourceDir,
      SUPACLOUD_PGREDIS_TRANSACTION_PARENT: dir,
    });

    expect(result.status).toBe(143);
    expect(readFileSync(binary, "utf8")).toBe("old-binary\n");
    expect(readFileSync(runtimeEnv, "utf8")).toBe("OLD_TOKEN=one\n");
  });

  test("management transaction signals restore Management before pgredis", () => {
    for (const [signal, status] of [["HUP", 129], ["INT", 130], ["TERM", 143]] as const) {
      const dir = makeTempDir();
      const snapshot = join(dir, "management-snapshot");
      const order = join(dir, "order");
      mkdirSync(snapshot);
      const result = runBash([
        "source install.sh",
        'recover_management_api_install() { printf "management\\n" >> "$ORDER"; [[ -d "$1" ]]; }',
        'rollback_pgredis_install_transaction() { printf "pgredis\\n" >> "$ORDER"; return 0; }',
        'trap \'abort_management_install_transaction "$SNAPSHOT" true false "$STATUS"\' ' + signal,
        'kill -' + signal + ' $$',
      ].join("; "), {
        ORDER: order,
        SNAPSHOT: snapshot,
        STATUS: String(status),
      });

      expect(result.status, result.stderr).toBe(status);
      expect(readFileSync(order, "utf8")).toBe("management\npgredis\n");
      expect(() => statSync(snapshot)).toThrow();
    }

    const dir = makeTempDir();
    const snapshot = join(dir, "management-snapshot");
    const order = join(dir, "order");
    mkdirSync(snapshot);
    const result = runBash([
      "source install.sh",
      'recover_management_api_install() { printf "management\\n" >> "$ORDER"; return 0; }',
      'rollback_pgredis_install_transaction() { printf "pgredis\\n" >> "$ORDER"; return 0; }',
      'trap \'abort_management_install_transaction "$SNAPSHOT" true false "$?"\' ERR EXIT',
      "false",
    ].join("; "), { ORDER: order, SNAPSHOT: snapshot });

    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(order, "utf8")).toBe("management\npgredis\n");
    expect(() => statSync(snapshot)).toThrow();
  });

  test("management transaction retains its snapshot when recovery fails", () => {
    const dir = makeTempDir();
    const snapshot = join(dir, "management-snapshot");
    const order = join(dir, "order");
    mkdirSync(snapshot);
    const result = runBash([
      "source install.sh",
      'recover_management_api_install() { printf "management\\n" >> "$ORDER"; return 1; }',
      'rollback_pgredis_install_transaction() { printf "pgredis\\n" >> "$ORDER"; return 0; }',
      'abort_management_install_transaction "$SNAPSHOT" true false 1',
    ].join("; "), { ORDER: order, SNAPSHOT: snapshot });

    expect(result.status).toBe(1);
    expect(readFileSync(order, "utf8")).toBe("management\npgredis\n");
    expect(statSync(snapshot).isDirectory()).toBeTrue();
  });

  test("installer and runtime derive the same domain-separated encryption-key fingerprint", () => {
    const encryptionKey = "current-encryption-key-0123456789abcdef";
    const result = runBash(
      'source scripts/lib/install_config.sh && supacloud_secret_key_fingerprint "$KEY"',
      { KEY: encryptionKey },
    );
    const expected = createHash("sha256")
      .update("supacloud:enc:v1:\0", "utf8")
      .update(encryptionKey, "utf8")
      .digest("hex");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  test("installer restores a service when systemctl reports failure after stopping it", () => {
    const dir = makeTempDir();
    const fakeBin = join(dir, "bin");
    const serviceState = join(dir, "service-state");
    const systemctl = join(fakeBin, "systemctl");
    mkdirSync(fakeBin);
    writeFileSync(serviceState, "active");
    writeFileSync(systemctl, [
      "#!/usr/bin/env bash",
      'case "$1" in',
      '  stop) printf inactive > "$SERVICE_STATE"; exit 1 ;;',
      '  is-active) [[ "$(cat "$SERVICE_STATE")" == active ]] ;;',
      '  start) printf active > "$SERVICE_STATE" ;;',
      "esac",
    ].join("\n"), { mode: 0o755 });

    const result = runBash(
      'source scripts/lib/install_config.sh; supacloud_stop_service_for_migration supacloud true; status=$?; printf "%s:%s" "$status" "$(cat "$SERVICE_STATE")"',
      { PATH: `${fakeBin}:${process.env.PATH}`, SERVICE_STATE: serviceState },
    );

    expect(result.stdout).toBe("1:active");
  });

  test("installer verifies a committed checkpoint without putting the encryption key in psql arguments", () => {
    const dir = makeTempDir();
    const fakeBin = join(dir, "bin");
    const psqlArgs = join(dir, "psql-args");
    const psql = join(fakeBin, "psql");
    const encryptionKey = "checkpoint-encryption-key-0123456789abcdef";
    mkdirSync(fakeBin);
    writeFileSync(psql, [
      "#!/usr/bin/env bash",
      'printf "%s\\n" "$*" >> "$PSQL_ARGS"',
      'if [[ "$*" == *to_regclass* ]]; then printf "t\\n"; else printf "t\\n"; fi',
    ].join("\n"), { mode: 0o755 });

    const result = runBash(
      'source scripts/lib/install_config.sh && supacloud_secret_rotation_checkpoint_status "$KEY"',
      { PATH: `${fakeBin}:${process.env.PATH}`, PSQL_ARGS: psqlArgs, KEY: encryptionKey },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("complete");
    expect(readFileSync(psqlArgs, "utf8")).not.toContain(encryptionKey);
  });

  test("installer persists one stable BFF signing secret only in the management runtime env", () => {
    const dir = makeTempDir();
    const runtimeEnv = join(dir, "management-api.env");
    const firstGenerated = "first-generated-bff-signing-secret-0123456789abcdef";
    const secondGenerated = "second-generated-bff-signing-secret-0123456789abcdef";

    const first = runBash([
      "source scripts/lib/install_config.sh",
      'secret=$(supacloud_stable_secret "$RUNTIME_ENV" SUPAOAUTH_BFF_SIGNING_SECRET "$GENERATED")',
      'supacloud_write_service_env_pairs "$RUNTIME_ENV" SUPAOAUTH_BFF_SIGNING_SECRET "$secret"',
      'printf %s "$secret"',
    ].join("; "), { RUNTIME_ENV: runtimeEnv, GENERATED: firstGenerated });
    const second = runBash(
      'source scripts/lib/install_config.sh; supacloud_stable_secret "$RUNTIME_ENV" SUPAOAUTH_BFF_SIGNING_SECRET "$GENERATED"',
      { RUNTIME_ENV: runtimeEnv, GENERATED: secondGenerated },
    );

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(first.stdout).toBe(firstGenerated);
    expect(second.stdout).toBe(firstGenerated);
    expect(readFileSync(runtimeEnv, "utf8")).toContain(`SUPAOAUTH_BFF_SIGNING_SECRET="${firstGenerated}"`);

    const installer = readFileSync(join(repoRoot, "install.sh"), "utf8");
    const installKeyBlock = installer.slice(
      installer.indexOf("SUPACLOUD_INSTALL_KEYS=("),
      installer.indexOf("SUPACLOUD_EXPLICIT_INSTALL_KEYS=()"),
    );
    expect(installKeyBlock).not.toContain("SUPAOAUTH_BFF_SIGNING_SECRET");
    expect(installer).toContain('supacloud_stable_secret "$MANAGEMENT_ENV_FILE" SUPAOAUTH_BFF_SIGNING_SECRET "$(openssl rand -hex 32)"');
    expect(installer).toContain('SUPAOAUTH_BFF_SIGNING_SECRET "$SUPAOAUTH_BFF_SIGNING_SECRET"');
  });

  test("repairs a legacy runtime-overwritten install config from root-only credentials", () => {
    const dir = makeTempDir();
    const template = join(dir, "config.env");
    const installInput = join(dir, "install.env");
    const credentials = join(dir, "supacloud-credentials.env");
    const jwtKeys = join(dir, "jwt-keys.env");
    writeFileSync(template, "POSTGRES_PASSWORD=DBUser.Supa\nSUPABASE_PUBLIC_DOMAIN=supa.example.com\n");
    writeFileSync(credentials, [
      "INTERNAL_IP=10.20.0.9",
      "PUBLIC_DOMAIN=api.recovered.example",
      "STUDIO_DOMAIN=studio.recovered.example",
      "POSTGRES_PASSWORD=recovered-database-secret",
      "DASHBOARD_USERNAME=operator",
      "DASHBOARD_PASSWORD=recovered-dashboard-secret",
      "GRAFANA_PASSWORD=recovered-grafana-secret",
      "JWT_SECRET=recovered-jwt-secret",
      "ANON_KEY=recovered-anon-key",
      "SERVICE_ROLE_KEY=recovered-service-role-key",
      "",
    ].join("\n"));

    const result = runBash('source install.sh && check_config', {
      SUPACLOUD_TEMPLATE_CONFIG_FILE: template,
      SUPACLOUD_INSTALL_CONFIG_FILE: installInput,
      SUPACLOUD_CREDENTIALS_FILE: credentials,
      SUPACLOUD_JWT_KEYS_FILE: jwtKeys,
    });

    expect(result.status, result.stderr).toBe(0);
    const repaired = readFileSync(installInput, "utf8");
    expect(repaired).toContain("INTERNAL_IP=10.20.0.9");
    expect(repaired).toContain("SUPABASE_PUBLIC_DOMAIN=api.recovered.example");
    expect(repaired).toContain("SUPABASE_STUDIO_DOMAIN=studio.recovered.example");
    expect(repaired).toContain("POSTGRES_PASSWORD=recovered-database-secret");
    expect(repaired).toContain("JWT_SECRET=recovered-jwt-secret");
    expect(repaired).not.toContain("BASE_DOMAIN=");
    expect(repaired).not.toContain("PGPASSWORD=");
  }, 15_000);
});
