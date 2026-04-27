import { $ } from "bun";
import * as p from "@clack/prompts";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { logger } from "./utils/logger";

const RELEASES_API = "https://api.github.com/repos/zuohuadong/supacloud/releases";
const BIN_TARGET = "/usr/local/bin/supacloud";
const MANAGEMENT_ENV_FILE = "/etc/supabase/management-api.env";
const LEGACY_CONFIG_FILE = "/opt/supacloud/config.env";
const DEFAULT_GITHUB_PROXY = "https://ghproxy.net/";

type GithubEndpoint = {
    label: string;
    proxyPrefix: string;
};

function resolveLinuxBinaryName() {
    if (os.platform() !== "linux") {
        throw new Error("Production binary upgrades are supported on Linux only. Use macOS binaries for local diagnostics.");
    }

    const arch = os.arch();
    if (arch === "arm64") return "supacloud-linux-arm64";
    if (arch === "x64") return "supacloud-linux-amd64";
    throw new Error(`Unsupported Linux architecture: ${arch}`);
}

function normalizeTag(tag: string) {
    const trimmed = tag.trim();
    if (!trimmed || trimmed === "latest") return "";
    return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

function resolveReleaseApiUrl(targetVersion?: string) {
    const tag = normalizeTag(targetVersion || process.env.SUPACLOUD_UPGRADE_TAG || process.env.SUPACLOUD_UPGRADE_VERSION || "");
    return tag ? `${RELEASES_API}/tags/${encodeURIComponent(tag)}` : `${RELEASES_API}/latest`;
}

function normalizeProxyPrefix(value: string) {
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "direct" || trimmed.toLowerCase() === "none") return "";
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function buildGithubEndpoints(extraProxy?: string): GithubEndpoint[] {
    const rawProxies = [
        extraProxy,
        process.env.SUPACLOUD_GITHUB_PROXY,
        ...(process.env.SUPACLOUD_GITHUB_PROXIES || "").split(","),
        DEFAULT_GITHUB_PROXY,
        "",
    ];

    const seen = new Set<string>();
    return rawProxies
        .map(value => normalizeProxyPrefix(value || ""))
        .filter(proxyPrefix => {
            if (seen.has(proxyPrefix)) return false;
            seen.add(proxyPrefix);
            return true;
        })
        .map(proxyPrefix => ({
            proxyPrefix,
            label: proxyPrefix ? proxyPrefix.replace(/\/$/, "") : "direct GitHub",
        }));
}

function withGithubProxy(url: string, endpoint: GithubEndpoint) {
    return endpoint.proxyPrefix ? `${endpoint.proxyPrefix}${url}` : url;
}

async function promptForGithubProxy(lastError: string) {
    p.log.warn(`GitHub download failed: ${lastError}`);
    const value = await p.text({
        message: "Enter another GitHub proxy URL, or type direct to retry GitHub directly",
        placeholder: DEFAULT_GITHUB_PROXY,
        defaultValue: DEFAULT_GITHUB_PROXY,
    });
    if (p.isCancel(value)) {
        p.cancel("Upgrade cancelled.");
        process.exit(1);
    }
    return String(value);
}

async function fetchReleaseMetadata(apiUrl: string, forceYes?: boolean) {
    let lastError = "";
    let endpoints = buildGithubEndpoints();

    while (true) {
        for (const endpoint of endpoints) {
            const requestUrl = withGithubProxy(apiUrl, endpoint);
            try {
                const response = await fetch(requestUrl, {
                    headers: { "User-Agent": "SupaCloud-CLI" },
                });
                if (!response.ok) {
                    lastError = `${endpoint.label} returned HTTP ${response.status}`;
                    continue;
                }
                return {
                    data: await response.json(),
                    endpoint,
                };
            } catch (error: unknown) {
                lastError = `${endpoint.label}: ${error instanceof Error ? error.message : String(error)}`;
            }
        }

        if (forceYes) {
            throw new Error(`Unable to retrieve GitHub release metadata. Last error: ${lastError}`);
        }

        const customProxy = await promptForGithubProxy(lastError);
        endpoints = buildGithubEndpoints(customProxy);
    }
}

function parseEnv(text: string) {
    return Object.fromEntries(
        text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#") && line.includes("="))
            .map(line => {
                const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
                const idx = normalized.indexOf("=");
                const key = normalized.slice(0, idx).trim();
                const raw = normalized.slice(idx + 1).trim();
                const value = raw.replace(/^"|"$/g, "").replace(/^'|'$/g, "");
                return [key, value];
            })
            .filter(([key]) => key.length > 0)
    );
}

async function readEnvFile(filePath: string) {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return {};
    return parseEnv(await file.text());
}

async function installBinary(downloadUrl: string, binaryName: string, preferredEndpoint: GithubEndpoint, forceYes?: boolean) {
    const tmpBinary = path.join(os.tmpdir(), `${binaryName}-${Date.now()}`);
    const stagedBinary = `${BIN_TARGET}.new`;
    const backupBinary = `${BIN_TARGET}.bak`;
    let lastError = "";
    let endpoints = buildGithubEndpoints(preferredEndpoint.proxyPrefix || undefined);

    while (true) {
        for (const endpoint of endpoints) {
            const requestUrl = withGithubProxy(downloadUrl, endpoint);
            const result = await $`curl -fsSL ${requestUrl} -o ${tmpBinary}`.nothrow().quiet();
            if (result.exitCode === 0) {
                await $`chmod 0755 ${tmpBinary}`;

                if (existsSync(BIN_TARGET)) {
                    await $`cp -f ${BIN_TARGET} ${backupBinary}`;
                }

                await $`install -m 0755 ${tmpBinary} ${stagedBinary}`;
                await $`mv -f ${stagedBinary} ${BIN_TARGET}`;
                await $`rm -f ${tmpBinary}`.nothrow().quiet();
                return endpoint;
            }
            lastError = `${endpoint.label}: ${result.stderr.toString().trim() || `curl exited ${result.exitCode}`}`;
        }

        await $`rm -f ${tmpBinary}`.nothrow().quiet();
        if (forceYes) {
            throw new Error(`Unable to download ${binaryName}. Last error: ${lastError}`);
        }

        const customProxy = await promptForGithubProxy(lastError);
        endpoints = buildGithubEndpoints(customProxy);
    }
}

async function runInitDb(env: Record<string, string | undefined>) {
    const proc = Bun.spawn([BIN_TARGET, "--init-db"], {
        stdout: "inherit",
        stderr: "inherit",
        env,
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
        throw new Error(`supacloud --init-db exited with code ${exitCode}`);
    }
}

async function restartServices() {
    const management = await $`systemctl restart supacloud`.nothrow().quiet();
    if (management.exitCode !== 0) {
        logger.warn("[Upgrade] Failed to restart supacloud.service", {
            stderr: management.stderr.toString().slice(-500),
        });
        throw new Error("Failed to restart supacloud.service");
    }

    await $`systemctl try-restart supacloud-edge-runtime`.nothrow().quiet();
}

export async function runUpgrade(options: { forceYes?: boolean; targetVersion?: string } = {}) {
    p.intro("\x1b[46m SupaCloud Binary Upgrade \x1b[0m");

    const s = p.spinner();
    s.start("Retrieving GitHub release metadata");

    try {
        if (os.userInfo().uid !== 0) {
            throw new Error("Please run the upgrade with root privileges (sudo).");
        }

        const binaryName = resolveLinuxBinaryName();
        const { data, endpoint } = await fetchReleaseMetadata(resolveReleaseApiUrl(options.targetVersion), options.forceYes);
        const remoteVersion = String(data.tag_name || "latest");
        const releaseAsset = Array.isArray(data.assets)
            ? data.assets.find((asset: Record<string, unknown>) => asset.name === binaryName)
            : null;
        const releaseUrl = typeof releaseAsset?.browser_download_url === "string"
            ? releaseAsset.browser_download_url
            : null;

        if (!releaseUrl) {
            throw new Error(`Release ${remoteVersion} does not contain required asset: ${binaryName}`);
        }

        s.stop(`Latest binary available: ${remoteVersion} (${binaryName}, via ${endpoint.label})`);

        const confirm = options.forceYes || await p.confirm({
            message: `Replace ${BIN_TARGET} with ${binaryName} from ${remoteVersion}?`,
            initialValue: true,
        });

        if (!confirm || p.isCancel(confirm)) {
            p.cancel("Upgrade cancelled.");
            return;
        }

        s.start(`Downloading and installing ${binaryName}`);
        const downloadEndpoint = await installBinary(releaseUrl, binaryName, endpoint, options.forceYes);

        const env = {
            ...process.env,
            ...(await readEnvFile(LEGACY_CONFIG_FILE)),
            ...(await readEnvFile(MANAGEMENT_ENV_FILE)),
        };

        s.start("Applying metadata database migrations");
        await runInitDb(env);

        s.start("Restarting SupaCloud services");
        await restartServices();

        p.outro(`SupaCloud upgraded to ${remoteVersion} via ${binaryName} (${downloadEndpoint.label})`);
    } catch (error: unknown) {
        s.stop(`Upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
