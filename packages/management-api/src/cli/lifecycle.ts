import { $ } from "bun";
import * as p from "@clack/prompts";
import fs from "node:fs/promises";
import { logger } from "../utils/logger";

// According to shell branch convention, Supabase Pigsty configuration directory
const PIGSTY_SUPABASE_DIR = `${process.env.HOME || "/root"}/pigsty/app/supabase`;

async function getComposeCmd() {
    const hasDockerCompose = await $`command -v docker-compose`.quiet().nothrow();
    if (hasDockerCompose.exitCode === 0) return "docker-compose";
    const hasDockerComposePlugin = await $`docker compose version`.quiet().nothrow();
    if (hasDockerComposePlugin.exitCode === 0) return "docker compose";
    return null;
}

export async function handleStart() {
    p.intro("🚀 Starting SupaCloud service stack...");
    const composeCmd = await getComposeCmd();
    if (!composeCmd) {
        p.log.error("docker-compose not found, please ensure environment initialization was completed via install.sh.");
        process.exit(1);
    }

    const s = p.spinner();
    s.start("Pulling up component containers (docker-compose up -d)...");
    try {
        await $`cd ${PIGSTY_SUPABASE_DIR} && ${composeCmd} up -d`.quiet();
        s.stop("Component start command execution complete.");
    } catch (e: unknown) {
        s.stop("Startup failed.");
        p.log.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
    p.outro("✅ Services are running in background.");
}

export async function handleStop() {
    p.intro("🛑 Stopping SupaCloud service stack...");
    const composeCmd = await getComposeCmd();
    if (!composeCmd) {
        p.log.error("docker-compose not found.");
        process.exit(1);
    }

    const s = p.spinner();
    s.start("Executing graceful shutdown (docker-compose down)...");
    try {
        await $`cd ${PIGSTY_SUPABASE_DIR} && ${composeCmd} down`.quiet();
        s.stop("Service stack fully stopped.");
    } catch (e: unknown) {
        s.stop("Error during shutdown.");
        p.log.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
    }
    p.outro("✅ Environment cleaned up.");
}

export async function handleStatus() {
    p.intro("🩺 Checking SupaCloud control plane status...");
    const composeCmd = await getComposeCmd();

    if (composeCmd) {
        const s = p.spinner();
        s.start("Fetching local container list...");
        try {
            const out = await $`cd ${PIGSTY_SUPABASE_DIR} && ${composeCmd} ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"`.quiet().text();
            s.stop("Container running status:");
            console.log(out);
        } catch (err: unknown) {
          logger.warn("[] start failed silently", { error: err });
            s.stop("Unable to get status via docker-compose.");
        }
    }

    // Port probing
    const activePorts = [];
    const ports = [8000, 3000, 5432, 9090];
    for (const port of ports) {
        const isUp = (await $`ss -tuln | grep :${port} `.nothrow().quiet()).exitCode === 0;
        if (isUp) activePorts.push(port);
    }

    if (activePorts.length > 0) {
        p.log.success(`Detected active business ports: ${activePorts.join(", ")}`);
    } else {
        p.log.warn("No active business ports detected, services may not have started yet.");
    }

    p.outro("Inspection complete.");
}

export async function handleLogs(serviceTarget?: string) {
    p.intro("📂 Getting diagnostic logs...");
    const composeCmd = await getComposeCmd();
    if (!composeCmd) {
        p.log.error("docker-compose not found.");
        process.exit(1);
    }

    const target = serviceTarget || "";
    try {
        await $`cd ${PIGSTY_SUPABASE_DIR} && ${composeCmd} logs --tail 50 ${target}`.nothrow();
    } catch (e: unknown) {
        p.log.error(`Log read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}
