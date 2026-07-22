import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";

const REQUEST_DIR = "/run/supacloud-unit-requests";
const MANAGED_UNIT_PATTERN = /^(?:supacloud-(?:pgrst|gotrue)@\.service|supacloud-frontend-[a-z0-9-]{1,64}\.service)$/;

async function runSystemctl(args: string[]): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn({ cmd: ["systemctl", ...args], stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr };
}

function assertManagedUnitName(unitName: string): void {
  if (!MANAGED_UNIT_PATTERN.test(unitName)) {
    throw new Error(`Systemd unit ${unitName} is outside the SupaCloud allow-list`);
  }
}

async function executeBrokerRequest(operation: "install" | "remove", unitName: string, content?: string): Promise<void> {
  assertManagedUnitName(unitName);
  await mkdir(REQUEST_DIR, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const requestPath = `${REQUEST_DIR}/${token}.request`;
  const sourcePath = `${REQUEST_DIR}/${token}.unit`;
  try {
    if (content !== undefined) {
      await writeFile(sourcePath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    await writeFile(
      requestPath,
      `operation=${operation}\nunit_name=${unitName}\n`,
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const result = await runSystemctl(["--wait", "start", `supacloud-systemd-unit@${token}.service`]);
    if (result.exitCode !== 0) {
      throw new Error(`Systemd unit broker failed for ${unitName}: ${result.stderr.trim().slice(0, 300)}`);
    }
  } finally {
    await rm(requestPath, { force: true });
    await rm(sourcePath, { force: true });
  }
}

export function installManagedSystemdUnit(unitName: string, content: string): Promise<void> {
  return executeBrokerRequest("install", unitName, content);
}

export function removeManagedSystemdUnit(unitName: string): Promise<void> {
  return executeBrokerRequest("remove", unitName);
}
