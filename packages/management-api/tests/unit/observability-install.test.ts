import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../..");
const readRepoFile = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

test("default installation uses native independent logs and never configures Logflare", () => {
  const template = readRepoFile("config.env");
  const installer = readRepoFile("install.sh");

  expect(template).toContain('SUPACLOUD_LOGS_ENABLED="true"');
  expect(template).toContain('VICTORIALOGS_VERSION="v1.52.0"');
  expect(template).not.toContain("VICTORIALOGS_IMAGE=");
  expect(template).not.toContain("VECTOR_IMAGE=");
  expect(template).not.toContain("ENABLE_ANALYTICS=");
  expect(template).not.toContain("LOGFLARE_");
  expect(installer).toContain("install_observability");
  expect(installer).not.toContain("configure_analytics");
  expect(installer).toContain("legacy stack installs Supabase Analytics (Logflare)");
  expect(installer).toContain("--apply --skip-analytics");
});

test("observability uses one native service and the embedded collector, without Grafana or PostgreSQL", () => {
  const victoriaLogsUnit = readRepoFile("infrastructure/systemd/supacloud-victorialogs.service");
  const collector = readRepoFile("packages/management-api/src/workers/local-log-collector.worker.ts");
  const victoriaLogsService = readRepoFile("packages/management-api/src/services/victorialogs.service.ts");
  const installer = readRepoFile("install.sh");

  expect(victoriaLogsUnit).toContain("-httpListenAddr=127.0.0.1:9428");
  expect(victoriaLogsUnit).not.toContain("ExecStart=${VICTORIALOGS_BINARY}");
  expect(victoriaLogsUnit).not.toContain("ExecStartPre=/usr/bin/test -x ${VICTORIALOGS_BINARY}");
  expect(victoriaLogsUnit).not.toMatch(/^ExecStart(?:Pre)?=\$\{/m);
  expect(victoriaLogsUnit).toContain("Environment=VICTORIALOGS_BINARY=/usr/local/bin/victoria-logs-prod");
  expect(victoriaLogsUnit).toContain("Environment=VICTORIALOGS_DATA_DIR=/var/lib/supacloud/victorialogs");
  expect(victoriaLogsUnit).toContain("Environment=VICTORIALOGS_RETENTION=7d");
  expect(victoriaLogsUnit).toContain('ExecStartPre=/bin/sh -ec \'test -x "$${VICTORIALOGS_BINARY}"\'');
  expect(victoriaLogsUnit).toContain('exec "$${VICTORIALOGS_BINARY}"');
  expect(victoriaLogsUnit).toContain('"-storageDataPath=$${VICTORIALOGS_DATA_DIR}"');
  expect(victoriaLogsUnit).toContain('"-retentionPeriod=$${VICTORIALOGS_RETENTION}"');
  expect(victoriaLogsUnit).not.toContain("podman");
  expect(victoriaLogsUnit).not.toContain("GRAFANA");
  expect(victoriaLogsUnit).not.toContain("POSTGRES");
  expect(collector).toContain('"journalctl", "--follow", "--no-pager", "--output=json"');
  expect(collector).toContain("config.edgeFunctionsDir");
  expect(victoriaLogsService).toContain("insert/jsonline");
  expect(collector).toContain("access[_-]?token");
  expect(installer).toContain("install_victorialogs_binary");
  expect(installer).toContain("supacloud-vector.service");
  expect(installer).toContain("systemctl disable --now supacloud-vector");
});

test("VictoriaLogs systemd wrapper honors EnvironmentFile overrides", () => {
  const victoriaLogsUnit = readRepoFile("infrastructure/systemd/supacloud-victorialogs.service");
  const shellCommand = victoriaLogsUnit.match(/^ExecStart=\/bin\/sh -ec '(.*)'$/m)?.[1];
  expect(shellCommand).toBeDefined();

  const runtimeDir = mkdtempSync(join(tmpdir(), "supacloud-victorialogs-unit-"));
  const fakeBinary = join(runtimeDir, "victoria logs prod");
  writeFileSync(fakeBinary, '#!/bin/sh\nprintf \'<%s>\\n\' "$@"\n');
  chmodSync(fakeBinary, 0o755);

  try {
    const execution = Bun.spawnSync({
      cmd: ["/bin/sh", "-ec", shellCommand!.replaceAll("$$", "$")],
      env: {
        VICTORIALOGS_BINARY: fakeBinary,
        VICTORIALOGS_DATA_DIR: "/srv/victoria logs",
        VICTORIALOGS_RETENTION: "30d",
      },
      stdout: "pipe",
    });
    expect(execution.exitCode).toBe(0);
    expect(execution.stdout.toString()).toBe(
      "<-storageDataPath=/srv/victoria logs>\n<-retentionPeriod=30d>\n<-httpListenAddr=127.0.0.1:9428>\n",
    );
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("Vector log collector configuration and systemd unit are complete and valid", () => {
  const vectorConfig = readRepoFile("infrastructure/vector/vector.toml");
  const vectorUnit = readRepoFile("infrastructure/systemd/supacloud-vector.service");
  const installer = readRepoFile("install.sh");

  expect(vectorConfig).toContain('[sources.journald]');
  expect(vectorConfig).toContain('type = "journald"');
  expect(vectorConfig).toContain('supacloud-gotrue@*.service');
  expect(vectorConfig).toContain('supacloud-pgrst@*.service');
  expect(vectorConfig).toContain('[sources.functions]');
  expect(vectorConfig).toContain('/opt/supacloud/functions/**/logs/*.log');
  expect(vectorConfig).toContain('[transforms.process_journal]');
  expect(vectorConfig).toContain('[transforms.process_functions]');
  expect(vectorConfig).toContain('[sinks.victorialogs]');
  expect(vectorConfig).toContain('http://127.0.0.1:9428/insert/jsonline');
  expect(vectorConfig).toContain('application/stream+json');

  expect(vectorUnit).toContain('Description=SupaCloud Vector Log Collector');
  expect(vectorUnit).toContain('Environment=VECTOR_CONFIG=/etc/supabase/vector.yaml');
  expect(vectorUnit).toContain('ExecStart=/bin/sh -ec \'exec "$${VECTOR_BINARY}" --config "$${VECTOR_CONFIG}"\'');

  expect(installer).toContain('install_vector_collector');
  expect(installer).toContain('SUPACLOUD_LOG_COLLECTOR_ENGINE');
});
