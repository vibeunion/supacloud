#!/usr/bin/env node
/**
 * supacloudctl — 统一入口（umbrella dispatcher）。
 *
 * 单一 `supacloudctl` 命令把子命令路由到对应的工作区包：
 *   supacloudctl cli   <args...>   → @supacloud/cli   （项目级开发工具）
 *   supacloudctl admin <args...>   → @supacloud/admin （平台运维工具）
 *
 * 普通分发默认完全离线；仅在显式请求时检查 npm latest dist-tag。
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

export interface UpdateCheckResult {
    packageName: string;
    currentVersion: string | null;
    latestVersion: string | null;
    status: "update_available" | "up_to_date" | "registry_unavailable" | "not_installed";
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

export function isAutoUpdateEnabled(env: Record<string, string | undefined> = process.env): boolean {
    if (isAutoUpdateDisabled(env)) return false;
    return Boolean(env.SUPACLOUD_AUTO_UPDATE);
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

async function updateNoticeForLaunch(
    target: Subcommand,
    installed: InstalledPackage,
    env: Record<string, string | undefined>,
    fetchLatest: NonNullable<LaunchPlanOptions["fetchLatest"]>,
): Promise<string | undefined> {
    if (!isAutoUpdateEnabled(env)) return undefined;
    const latestVersion = await fetchLatest(target.pkg, env);
    if (!latestVersion || !isNewerVersion(latestVersion, installed.version)) return undefined;
    return installed.version
        ? `${target.pkg} ${latestVersion} 可用；当前固定使用已安装版本 ${installed.version}。请显式运行包管理器更新。`
        : `${target.pkg} ${latestVersion} 可用；已安装版本无法识别，请通过包管理器检查锁定版本。`;
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

    if (!installed) {
        throw new Error(`${target.pkg} 未安装。请先通过包管理器显式安装固定版本。`);
    }

    const updateNotice = await updateNoticeForLaunch(target, installed, env, fetchLatest);

    return {
        mode: "local",
        command: options.nodePath ?? process.execPath,
        args: [installed.entry, ...forwardedArgs],
        shell: false,
        ...(updateNotice ? { updateNotice } : {}),
    };
}

export async function checkUpdate(
    target: Subcommand,
    options: LaunchPlanOptions = {},
): Promise<UpdateCheckResult> {
    const env = options.env ?? process.env;
    const resolveInstalled = options.resolveInstalled ?? resolveInstalledPackage;
    const fetchLatest = options.fetchLatest ?? fetchLatestVersion;
    const installed = resolveInstalled(target.pkg);
    if (!installed) return missingPackageCheck(target.pkg);

    const latestVersion = await fetchLatest(target.pkg, env);
    if (!latestVersion) return unavailableRegistryCheck(target.pkg, installed.version);
    return completedUpdateCheck(target.pkg, installed.version, latestVersion);
}

function missingPackageCheck(packageName: string): UpdateCheckResult {
    return { packageName, currentVersion: null, latestVersion: null, status: "not_installed" };
}

function unavailableRegistryCheck(packageName: string, currentVersion: string | null): UpdateCheckResult {
    return { packageName, currentVersion, latestVersion: null, status: "registry_unavailable" };
}

function completedUpdateCheck(packageName: string, currentVersion: string | null, latestVersion: string): UpdateCheckResult {
    const status = isNewerVersion(latestVersion, currentVersion) ? "update_available" : "up_to_date";
    return { packageName, currentVersion, latestVersion, status };
}

function formatUpdateCheck(check: UpdateCheckResult): string {
    switch (check.status) {
        case "update_available":
            return `${check.packageName}: ${check.latestVersion} 可用（当前 ${check.currentVersion ?? "未知"}）`;
        case "up_to_date":
            return `${check.packageName}: 已是最新版本 ${check.currentVersion ?? check.latestVersion ?? "未知"}`;
        case "not_installed":
            return `${check.packageName}: 未安装`;
        case "registry_unavailable":
            return `${check.packageName}: 无法从 npm registry 获取版本信息`;
    }
}

export function buildHelp(): string {
    const subcommandHelp = Object.entries(SUBCOMMANDS)
        .map(([name, sub]) => `  ${name.padEnd(6)} ${sub.desc}`)
        .join("\n");
    return `
╔═══════════════════════════════════════════════════════════╗
║  supacloudctl                                            ║
║  统一入口 · 路由到项目级 CLI 与平台运维 CLI              ║
╚═══════════════════════════════════════════════════════════╝

用法

  ${COMMAND} <子命令> [args...]
  ${COMMAND} check-update [cli|admin]
  ${COMMAND} --help

子命令

${subcommandHelp}

示例

  ${COMMAND} cli status
  ${COMMAND} cli project get
  ${COMMAND} cli gateway routes --ref <ref>
  ${COMMAND} admin status
  ${COMMAND} admin project list
  ${COMMAND} admin ssh ping
  ${COMMAND} check-update
  ${COMMAND} check-update cli

普通分发默认不访问 npm，始终运行已安装的固定版本。
使用 check-update 显式查询更新；SUPACLOUD_AUTO_UPDATE=1 可选择恢复分发前提示。
`;
}

async function runUpdateCheckCommand(args: string[]): Promise<never> {
    const targetName = args[1];
    if (args.length > 2 || (targetName && !SUBCOMMANDS[targetName])) {
        console.error(`❌ 未知更新检查目标: ${targetName ?? ""}`);
        process.exit(1);
    }
    const targets = targetName ? [SUBCOMMANDS[targetName]] : Object.values(SUBCOMMANDS);
    const checks = await Promise.all(targets.map((target) => checkUpdate(target)));
    for (const check of checks) console.log(formatUpdateCheck(check));
    const failed = checks.some((check) => ["registry_unavailable", "not_installed"].includes(check.status));
    process.exit(failed ? 1 : 0);
}

async function dispatchSubcommand(target: Subcommand, forwardedArgs: string[]): Promise<void> {
    const launchPlan = await createLaunchPlan(target, forwardedArgs);
    if (launchPlan.updateNotice) console.error(`ℹ️ ${launchPlan.updateNotice}`);
    const childProcess = spawn(launchPlan.command, launchPlan.args, {
        stdio: "inherit",
        shell: launchPlan.shell,
    });
    childProcess.on("close", (code) => process.exit(code ?? 1));
    childProcess.on("error", (error) => {
        console.error(`❌ 启动 ${target.pkg} 失败: ${error.message}`);
        process.exit(1);
    });
}

async function run(args: string[]): Promise<void> {
    const subcommandName = args[0];

    if (!subcommandName || subcommandName === "--help" || subcommandName === "-h" || subcommandName === "help") {
        console.error(buildHelp());
        process.exit(0);
    }

    if (subcommandName === "check-update") await runUpdateCheckCommand(args);

    const target = SUBCOMMANDS[subcommandName];
    if (!target) {
        console.error(`❌ 未知子命令: ${subcommandName}\n`);
        console.error(buildHelp());
        process.exit(1);
    }
    await dispatchSubcommand(target, args.slice(1));
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
