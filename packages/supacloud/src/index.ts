#!/usr/bin/env node
/**
 * supacloudctl — 统一入口（umbrella dispatcher）。
 *
 * 单一 `supacloudctl` 命令把子命令路由到对应的工作区包：
 *   supacloudctl cli   <args...>   → @supacloud/cli   （项目级开发工具）
 *   supacloudctl admin <args...>   → @supacloud/admin （平台运维工具）
 *
 * 默认只检查 npm latest dist-tag 并提示更新；始终执行随包安装的固定版本。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

interface Subcommand {
    pkg: string;
    bin: string;
    desc: string;
}

export const SUBCOMMANDS: Record<string, Subcommand> = {
    cli: { pkg: "@supacloud/cli", bin: "supacloud-cli", desc: "@supacloud/cli 项目级开发工具" },
    admin: { pkg: "@supacloud/admin", bin: "supacloud-admin", desc: "@supacloud/admin 平台运维工具" },
};

interface InstalledPackage {
    entry: string;
    version: string | null;
}

interface LaunchPlan {
    mode: "local";
    command: string;
    args: string[];
    shell: boolean;
    updateNotice?: string;
}

interface LaunchPlanOptions {
    env?: Record<string, string | undefined>;
    fetchLatest?: (pkgName: string, env?: Record<string, string | undefined>) => Promise<string | null>;
    resolveInstalled?: (pkgName: string) => InstalledPackage | null;
    nodePath?: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

/** 解析子包入口（package.json 的 main → dist/index.js）。未安装返回 null。 */
export function resolveSubpackageEntry(pkgName: string): string | null {
    try {
        return require.resolve(pkgName);
    } catch {
        return null;
    }
}

const COMMAND = "supacloudctl";
const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org/";
const AUTO_UPDATE_TIMEOUT_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPackageVersion(packageJsonPath: string): string | null {
    try {
        const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        if (isRecord(parsed) && typeof parsed.version === "string") return parsed.version;
    } catch {
        // 元数据无效时保留未知版本；仍只执行本地已安装入口。
    }
    return null;
}

function packageJsonMatches(path: string, pkgName: string): boolean {
    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        return isRecord(parsed) && parsed.name === pkgName;
    } catch {
        return false;
    }
}

function findPackageJsonFromEntry(entry: string, pkgName: string): string | null {
    let dir = dirname(entry);
    const root = parse(dir).root;

    while (dir && dir !== root) {
        const candidate = join(dir, "package.json");
        if (existsSync(candidate) && packageJsonMatches(candidate, pkgName)) {
            return candidate;
        }
        dir = dirname(dir);
    }

    return null;
}

export function resolveInstalledPackage(pkgName: string): InstalledPackage | null {
    const entry = resolveSubpackageEntry(pkgName);
    if (!entry) return null;

    let packageJsonPath: string | null = null;
    try {
        packageJsonPath = require.resolve(`${pkgName}/package.json`);
    } catch {
        packageJsonPath = findPackageJsonFromEntry(entry, pkgName);
    }

    return {
        entry,
        version: packageJsonPath ? readPackageVersion(packageJsonPath) : null,
    };
}

export function isAutoUpdateDisabled(env: Record<string, string | undefined> = process.env): boolean {
    const noAutoUpdate = env.SUPACLOUD_NO_AUTO_UPDATE;
    if (noAutoUpdate && !["0", "false", "no", "off"].includes(noAutoUpdate.toLowerCase())) {
        return true;
    }

    const autoUpdate = env.SUPACLOUD_AUTO_UPDATE;
    return Boolean(autoUpdate && ["0", "false", "no", "off"].includes(autoUpdate.toLowerCase()));
}

export function getNpmRegistry(env: Record<string, string | undefined> = process.env): string {
    const registry =
        env.SUPACLOUD_NPM_REGISTRY ||
        env.npm_config_registry ||
        env.NPM_CONFIG_REGISTRY ||
        DEFAULT_NPM_REGISTRY;
    return registry.endsWith("/") ? registry : `${registry}/`;
}

export function buildLatestMetadataUrl(pkgName: string, registry = DEFAULT_NPM_REGISTRY): string {
    const base = registry.endsWith("/") ? registry : `${registry}/`;
    const encodedName = encodeURIComponent(pkgName).replace(/^%40/, "@");
    return `${base}${encodedName}/latest`;
}

export async function fetchLatestVersion(
    pkgName: string,
    env: Record<string, string | undefined> = process.env,
    fetchImpl?: FetchLike,
): Promise<string | null> {
    const activeFetch: FetchLike | undefined = fetchImpl ?? globalThis.fetch;
    if (!activeFetch) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTO_UPDATE_TIMEOUT_MS);

    try {
        const response = await activeFetch(buildLatestMetadataUrl(pkgName, getNpmRegistry(env)), {
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) return null;

        const metadata: unknown = await response.json();
        if (isRecord(metadata) && typeof metadata.version === "string") {
            return metadata.version;
        }
        return null;
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function parseSemver(version: string): { main: number[]; prerelease: string | null } | null {
    const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return null;

    return {
        main: [Number(match[1]), Number(match[2]), Number(match[3])],
        prerelease: match[4] ?? null,
    };
}

export function compareSemver(left: string, right: string): number {
    const a = parseSemver(left);
    const b = parseSemver(right);
    if (!a || !b) return left.localeCompare(right);

    for (let i = 0; i < 3; i += 1) {
        if (a.main[i] !== b.main[i]) return a.main[i] > b.main[i] ? 1 : -1;
    }

    if (a.prerelease === b.prerelease) return 0;
    if (!a.prerelease) return 1;
    if (!b.prerelease) return -1;
    return a.prerelease.localeCompare(b.prerelease);
}

export function isNewerVersion(latestVersion: string, currentVersion: string | null): boolean {
    if (!currentVersion) return true;
    return compareSemver(latestVersion, currentVersion) > 0;
}

export async function createLaunchPlan(
    target: Subcommand,
    forwardedArgs: string[],
    options: LaunchPlanOptions = {},
): Promise<LaunchPlan> {
    const env = options.env ?? process.env;
    const resolveInstalled = options.resolveInstalled ?? resolveInstalledPackage;
    const fetchLatest = options.fetchLatest ?? fetchLatestVersion;
    const installed = resolveInstalled(target.pkg);
    let updateNotice: string | undefined;

    if (!isAutoUpdateDisabled(env)) {
        const latestVersion = await fetchLatest(target.pkg, env);
        if (latestVersion && isNewerVersion(latestVersion, installed?.version ?? null)) {
            updateNotice = installed?.version
                ? `${target.pkg} ${latestVersion} 可用；当前固定使用已安装版本 ${installed.version}。请显式运行包管理器更新。`
                : `${target.pkg} ${latestVersion} 可用；请先通过包管理器显式安装。`;
        }
    }

    if (!installed) {
        throw new Error(`${target.pkg} 未安装。请先通过包管理器显式安装固定版本。`);
    }

    return {
        mode: "local",
        command: options.nodePath ?? process.execPath,
        args: [installed.entry, ...forwardedArgs],
        shell: false,
        ...(updateNotice ? { updateNotice } : {}),
    };
}

export function buildHelp(): string {
    const subs = Object.entries(SUBCOMMANDS)
        .map(([name, sub]) => `  ${name.padEnd(6)} ${sub.desc}`)
        .join("\n");
    return `
╔═══════════════════════════════════════════════════════════╗
║  supacloudctl                                            ║
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

每次执行子命令时默认检查 npm latest；发现新版本时只输出更新提示，
始终运行已安装的固定版本。设置 SUPACLOUD_NO_AUTO_UPDATE=1 可禁用检查。
`;
}

async function run(args: string[]): Promise<void> {
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

    const plan = await createLaunchPlan(target, args.slice(1));
    if (plan.updateNotice) {
        console.error(`ℹ️ ${plan.updateNotice}`);
    }

    // 把子命令之后的参数原样透传给子包入口
    const child = spawn(plan.command, plan.args, {
        stdio: "inherit",
        shell: plan.shell,
    });

    child.on("close", (code) => process.exit(code ?? 1));
    child.on("error", (err) => {
        console.error(`❌ 启动 ${target.pkg} 失败: ${err.message}`);
        process.exit(1);
    });
}

export function isMainModule(moduleUrl: string, argvEntry = process.argv[1]): boolean {
    if (!argvEntry) return false;
    try {
        return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
    } catch {
        return false;
    }
}

// 仅在作为脚本直接运行时执行分发，避免被 import（如测试）时的副作用退出
if (isMainModule(import.meta.url)) {
    run(process.argv.slice(2)).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`❌ supacloudctl 启动失败: ${message}`);
        process.exit(1);
    });
}
