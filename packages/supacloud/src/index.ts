#!/usr/bin/env node
/**
 * supacloud — 统一入口（umbrella dispatcher）。
 *
 * 单一 `supacloud` 命令把子命令路由到对应的工作区包：
 *   supacloud cli   <args...>   → @supacloud/cli   （项目级开发工具）
 *   supacloud admin <args...>   → @supacloud/admin （平台运维工具）
 *
 * 子包以依赖形式安装；运行时通过 createRequire 解析子包入口，
 * 用当前 Node 进程 spawn 执行，参数与退出码原样透传。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

interface Subcommand {
    pkg: string;
    desc: string;
}

export const SUBCOMMANDS: Record<string, Subcommand> = {
    cli: { pkg: "@supacloud/cli", desc: "项目级 CLI（开发者工具）" },
    admin: { pkg: "@supacloud/admin", desc: "平台运维 CLI（安装/SSH/租户管理）" },
};

/** 解析子包入口（package.json 的 main → dist/index.js）。未安装返回 null。 */
export function resolveSubpackageEntry(pkgName: string): string | null {
    try {
        return require.resolve(pkgName);
    } catch {
        return null;
    }
}

const COMMAND = "supacloud";

export function buildHelp(): string {
    const subs = Object.entries(SUBCOMMANDS)
        .map(([name, sub]) => `  ${name.padEnd(6)} ${sub.desc}`)
        .join("\n");
    return `
╔═══════════════════════════════════════════════════════════╗
║  supacloud                                               ║
║  统一入口 · 路由到项目级 CLI 与平台运维 CLI              ║
╚═══════════════════════════════════════════════════════════╝

用法

  ${COMMAND} <子命令> [args...]
  ${COMMAND} --help

子命令

${subs}

示例

  ${COMMAND} cli status
  ${COMMAND} cli project get
  ${COMMAND} cli gateway routes --ref <ref>
  ${COMMAND} admin status
  ${COMMAND} admin project list
  ${COMMAND} admin ssh ping

每个子命令都接受各自的 --help。安装后 supacloud 同时拥有
cli 与 admin 的全部能力；二者也可单独安装为 @supacloud/cli /
@supacloud/admin，通过 supacloud-cli / supacloud-admin 调用。
`;
}

function run(args: string[]): void {
    const sub = args[0];

    if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
        console.error(buildHelp());
        process.exit(0);
    }

    const target = SUBCOMMANDS[sub];
    if (!target) {
        console.error(`❌ 未知子命令: ${sub}\n`);
        console.error(buildHelp());
        process.exit(1);
    }

    const entry = resolveSubpackageEntry(target.pkg);
    if (!entry) {
        console.error(`❌ ${target.pkg} 未安装。请确认 supacloud 包依赖完整，或单独安装 ${target.pkg}。`);
        process.exit(1);
    }

    // 把子命令之后的参数原样透传给子包入口
    const child = spawn(process.execPath, [entry, ...args.slice(1)], {
        stdio: "inherit",
    });

    child.on("close", (code) => process.exit(code ?? 1));
    child.on("error", (err) => {
        console.error(`❌ 启动 ${target.pkg} 失败: ${err.message}`);
        process.exit(1);
    });
}

// 仅在作为脚本直接运行时执行分发，避免被 import（如测试）时的副作用退出
const isMainEntry = (() => {
    try {
        return fileURLToPath(import.meta.url) === process.argv[1];
    } catch {
        return false;
    }
})();
if (isMainEntry) run(process.argv.slice(2));
