#!/usr/bin/env node
/**
 * supacloud — 统一入口（umbrella dispatcher）。
 *
 * 单一 `supacloud` 命令把子命令路由到对应的工作区包：
 *   supacloud cli   <args...>   → @supacloud/cli   （项目级开发工具）
 *   supacloud admin <args...>   → @supacloud/admin （平台运维工具）
 *
 * 默认先检查 npm latest dist-tag；发现新版本时通过 npm exec 运行最新版。
 * 离线、registry 不可达或显式禁用自动更新时，回退到随包安装的本地依赖。
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
    cli: { pkg: "@supacloud/cli", bin: "supacloud-cli", desc: "项目级 CLI（开发者工具）" },
    admin: { pkg: "@supacloud/admin", bin: "supacloud-admin", desc: "平台运维 CLI（安装/SSH/租户管理）" },
};

interface InstalledPackage {
    entry: string;
    version: string | null;
}

interface LaunchPlan {
    mode: "latest" | "local";
    command: string;
    args: string[];
    shell: boolean;
}

interface LaunchPlanOptions {
    env?: Record<string, string | undefined>;
    fetchLatest?: (pkgName: string, env?: Record<string, string | undefined>) => Promise<string | null>;
    resolveInstalled?: (pkgName: string) => InstalledPackage | null;
    nodePath?: string;
    npmCommand?: string;
    platform?: NodeJS.Platform;
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

const COMMAND = "supacloud";
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
        // ignore malformed package metadata and fall back to latest execution
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

    if (!isAutoUpdateDisabled(env)) {
        const latestVersion = await fetchLatest(target.pkg, env);
        if (latestVersion && isNewerVersion(latestVersion, installed?.version ?? null)) {
            return {
                mode: "latest",
                command: options.npmCommand ?? "npm",
                args: ["exec", "--yes", "--package", `${target.pkg}@${latestVersion}`, "--", target.bin, ...forwardedArgs],
                shell: (options.platform ?? process.platform) === "win32",
            };
        }
    }

    if (!installed) {
        throw new Error(`${target.pkg} 未安装，且无法从 npm registry 获取最新版。`);
    }

    return {
        mode: "local",
        command: options.nodePath ?? process.execPath,
        args: [installed.entry, ...forwardedArgs],
        shell: false,
    };
}

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

每次执行子命令时默认检查 npm latest；发现 @supacloud/cli 或
@supacloud/admin 有新版本时会自动通过 npm exec 运行最新版。
离线时回退到本地依赖。设置 SUPACLOUD_NO_AUTO_UPDATE=1 可禁用。
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
        console.error(`❌ supacloud 启动失败: ${message}`);
        process.exit(1);
    });
}
