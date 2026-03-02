import { $ } from "bun";
import * as p from "@clack/prompts";
import fs from "node:fs/promises";

// 根据 shell 分支的约定，Supabase Pigsty 配置目录
const PIGSTY_SUPABASE_DIR = `${process.env.HOME || "/root"}/pigsty/app/supabase`;

async function getComposeCmd() {
    const hasDockerCompose = await $`command -v docker-compose`.quiet().nothrow();
    if (hasDockerCompose.exitCode === 0) return "docker-compose";
    const hasDockerComposePlugin = await $`docker compose version`.quiet().nothrow();
    if (hasDockerComposePlugin.exitCode === 0) return "docker compose";
    return null;
}

export async function handleStart() {
    p.intro("🚀 正在启动 SupaCloud 服务栈...");
    const composeCmd = await getComposeCmd();
    if (!composeCmd) {
        p.log.error("未找到 docker-compose，请确保已通过 install.sh 完成环境初始化。");
        process.exit(1);
    }

    const s = p.spinner();
    s.start("正在拉起组件容器 (docker-compose up -d)...");
    try {
        await $`cd ${PIGSTY_SUPABASE_DIR} && ${composeCmd} up -d`.quiet();
        s.stop("组件启动指令执行完成。");
    } catch (e: any) {
        s.stop("启动失败。");
        p.log.error(e.message);
        process.exit(1);
    }
    p.outro("✅ 服务已在后台运行。");
}

export async function handleStop() {
    p.intro("🛑 正在停止 SupaCloud 服务栈...");
    const composeCmd = await getComposeCmd();
    if (!composeCmd) {
        p.log.error("未找到 docker-compose。");
        process.exit(1);
    }

    const s = p.spinner();
    s.start("正在执行优雅停机 (docker-compose down)...");
    try {
        await $`cd ${PIGSTY_SUPABASE_DIR} && ${composeCmd} down`.quiet();
        s.stop("服务栈已完全停止。");
    } catch (e: any) {
        s.stop("停止过程中出现错误。");
        p.log.error(e.message);
        process.exit(1);
    }
    p.outro("✅ 环境已清理。");
}

export async function handleStatus() {
    p.intro("🩺 查看 SupaCloud 控制面状态...");
    const composeCmd = await getComposeCmd();

    if (composeCmd) {
        const s = p.spinner();
        s.start("抓取本地容器列表...");
        try {
            const out = await $`cd ${PIGSTY_SUPABASE_DIR} && ${composeCmd} ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"`.quiet().text();
            s.stop("容器运行状态:");
            console.log(out);
        } catch {
            s.stop("无法通过 docker-compose 获取状态。");
        }
    }

    // 端口探测
    const activePorts = [];
    const ports = [8000, 3000, 5432, 9090];
    for (const port of ports) {
        const isUp = (await $`ss -tuln | grep :${port} `.nothrow().quiet()).exitCode === 0;
        if (isUp) activePorts.push(port);
    }

    if (activePorts.length > 0) {
        p.log.success(`侦听到存活业务端口: ${activePorts.join(", ")}`);
    } else {
        p.log.warn("未侦听到任何活跃的业务端口，服务可能尚未启动。");
    }

    p.outro("巡检结束。");
}

export async function handleLogs(serviceTarget?: string) {
    p.intro("📂 获取诊断日志...");
    const composeCmd = await getComposeCmd();
    if (!composeCmd) {
        p.log.error("未找到 docker-compose。");
        process.exit(1);
    }

    const target = serviceTarget || "";
    try {
        await $`cd ${PIGSTY_SUPABASE_DIR} && ${composeCmd} logs --tail 50 ${target}`.nothrow();
    } catch (e: any) {
        p.log.error(`日志读取失败: ${e.message}`);
    }
}
