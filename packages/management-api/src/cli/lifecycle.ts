import { $ } from "bun";
import * as p from "@clack/prompts";
import { logger } from "../utils/logger";

const CONTROL_UNITS = ["supacloud", "kong", "supacloud-realtime"];

async function unitExists(unit: string): Promise<boolean> {
  const normalized = unit.endsWith(".service") ? unit : `${unit}.service`;
  return (await $`systemctl cat ${normalized}`.quiet().nothrow()).exitCode === 0;
}

async function runSystemctl(action: "start" | "stop" | "restart", units: string[]) {
  const results: string[] = [];

  for (const unit of units) {
    if (!(await unitExists(unit))) {
      results.push(`${unit}: not installed`);
      continue;
    }

    const result = await $`systemctl ${action} ${unit}`.quiet().nothrow();
    const past = action === "stop" ? "stopped" : action === "start" ? "started" : "restarted";
    results.push(`${unit}: ${result.exitCode === 0 ? past : "failed"}`);
  }

  return results;
}

async function listSupaCloudContainers(): Promise<string> {
  if ((await $`command -v podman`.quiet().nothrow()).exitCode === 0) {
    return await $`podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`.quiet().text().catch(() => "");
  }
  if ((await $`command -v docker`.quiet().nothrow()).exitCode === 0) {
    return await $`docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"`.quiet().text().catch(() => "");
  }
  return "";
}

export async function handleStart() {
  p.intro("Starting SupaCloud control plane...");

  const s = p.spinner();
  s.start("Starting systemd services...");
  const results = await runSystemctl("start", CONTROL_UNITS);
  s.stop("Service start command complete.");

  for (const line of results) p.log.info(line);
  p.outro("SupaCloud control plane start complete.");
}

export async function handleStop() {
  p.intro("Stopping SupaCloud control plane...");

  const s = p.spinner();
  s.start("Stopping systemd services...");
  const results = await runSystemctl("stop", ["supacloud", "supacloud-realtime"]);
  s.stop("Service stop command complete.");

  for (const line of results) p.log.info(line);
  p.log.warn("Tenant PostgREST/GoTrue units are not stopped by this command; use project pause/delete for tenant lifecycle.");
  p.outro("SupaCloud control plane stop complete.");
}

export async function handleStatus() {
  p.intro("Checking SupaCloud control plane status...");

  for (const unit of CONTROL_UNITS) {
    if (!(await unitExists(unit))) {
      p.log.warn(`${unit}: not installed`);
      continue;
    }

    const status = await $`systemctl is-active ${unit}`.quiet().nothrow();
    p.log.info(`${unit}: ${status.exitCode === 0 ? "active" : "inactive"}`);
  }

  const tenantUnits = await $`systemctl list-units 'supacloud-pgrst@*' 'supacloud-gotrue@*' --state=running --no-legend`.quiet().text().catch(() => "");
  if (tenantUnits) {
    const count = tenantUnits.split("\n").filter((line) => line.trim()).length;
    p.log.info(`running tenant runtime units: ${count}`);
  }

  const containers = await listSupaCloudContainers();
  if (containers.trim()) {
    p.log.info("Container status:");
    console.log(containers);
  }

  p.outro("Inspection complete.");
}

export async function handleLogs(serviceTarget?: string) {
  p.intro("Getting diagnostic logs...");

  const target = serviceTarget || "supacloud";
  if (!(await unitExists(target))) {
    p.log.error(`systemd unit not found: ${target}`);
    process.exit(1);
  }

  try {
    await $`journalctl -u ${target} -n 80 --no-pager`.nothrow();
  } catch (e: unknown) {
    logger.warn("[CLI] Failed to read service logs", { target, error: e });
    p.log.error(`Log read failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
