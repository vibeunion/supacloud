import { expect, test } from "bun:test";
import { VictoriaLogsService } from "../../src/services/victorialogs.service";

const nativeTest = process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE === "1" ? test : test.skip;

async function docker(...args: string[]): Promise<string> {
  const child = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Docker fixture failed (${exitCode}): ${stderr}`);
  return stdout.trim();
}

nativeTest("real VictoriaLogs preserves project isolation and the log query/ingest contract", async () => {
  const name = `supacloud-victorialogs-types-${crypto.randomUUID()}`;
  try {
    await docker("run", "--rm", "-d", "--name", name, "-p", "127.0.0.1::9428",
      "--tmpfs", "/storage:rw,nosuid,size=128m",
      "victoriametrics/victoria-logs:v1.52.0", "-storageDataPath=/storage", "-retentionPeriod=1d");
    const address = await docker("port", name, "9428/tcp");
    if (!/^127\.0\.0\.1:\d+$/.test(address)) throw new Error("Unexpected VictoriaLogs fixture binding");
    const service = new VictoriaLogsService({ baseUrl: `http://${address}`, timeoutMs: 1000 });
    const deadline = Date.now() + 20_000;
    while (!(await service.isHealthy())) {
      if (Date.now() > deadline) throw new Error("VictoriaLogs fixture did not become healthy");
      await Bun.sleep(50);
    }
    const timestamp = new Date().toISOString();
    await service.ingest([
      { timestamp, message: "fixture request Authorization: Bearer synthetic", projectRef: "project_a", service: "auth", severity: "warning" },
      { timestamp, message: "other-project-private", projectRef: "project_b", service: "auth" },
    ]);
    let records = await service.queryProjectLogs("project_a", { service: "auth", search: "fixture" });
    while (records.length === 0) {
      if (Date.now() > deadline) throw new Error("VictoriaLogs did not expose the ingested fixture");
      await Bun.sleep(100);
      records = await service.queryProjectLogs("project_a", { service: "auth", search: "fixture" });
    }
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ timestamp, service: "auth", severity: "warning" });
    expect(records[0]?.event_message).toContain("Authorization=[REDACTED]");
    expect(JSON.stringify(records)).not.toContain("synthetic");
    expect(JSON.stringify(records)).not.toContain("other-project-private");
    expect(records[0]?.metadata.project_ref).toBe("project_a");
  } finally {
    await docker("rm", "-f", name).catch(() => {});
  }
}, 180_000);
