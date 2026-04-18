import { $ } from "bun";
import * as p from "@clack/prompts";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { logger } from "./utils/logger";

const REPO_URL = "https://api.github.com/repos/zuohuadong/supacloud/releases/latest";
const INSTALL_BASE_DIR = "/opt/supacloud";

function resolveInstallerPath() {
    const candidates = [
        path.join(process.cwd(), "install.sh"),
        path.join(INSTALL_BASE_DIR, "install.sh")
    ];
    return candidates.find(candidate => existsSync(candidate)) || null;
}

function getConfigFilePath(installerPath: string) {
    return path.join(path.dirname(installerPath), "config.env");
}

async function ensureInstallerAvailable(installerPath: string) {
    await $`chmod +x ${installerPath}`.quiet();
}

async function readCurrentConfig(installerPath: string) {
    const configFile = Bun.file(getConfigFilePath(installerPath));
    if (!(await configFile.exists())) {
        return null;
    }
    const text = await configFile.text();
    return Object.fromEntries(
        text
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(line => line && !line.startsWith("#") && line.includes("="))
            .map(line => {
                const idx = line.indexOf("=");
                const key = line.slice(0, idx);
                const raw = line.slice(idx + 1).trim();
                const value = raw.replace(/^"|"$/g, "");
                return [key, value];
            })
    );
}

export async function runUpgrade(options: { forceYes?: boolean } = {}) {
    p.intro("\x1b[46m SupaCloud Upgrade \x1b[0m");

    const s = p.spinner();
    s.start("Retrieving latest GitHub release version");

    try {
        const installerPath = resolveInstallerPath();
        if (!installerPath) {
            throw new Error("install.sh not found. Please run from the repository root or install to /opt/supacloud first.");
        }

        const response = await fetch(REPO_URL, {
            headers: { "User-Agent": "SupaCloud-CLI" }
        });

        if (!response.ok) throw new Error("Unable to connect to GitHub Release API");

        const data = await response.json();
        const remoteVersion = String(data.tag_name || "latest").replace('v', '');
        s.stop(`Latest version available: ${remoteVersion}`);

        const confirm = options.forceYes || await p.confirm({
            message: `Upgrade SupaCloud to ${remoteVersion} via canonical install.sh now?`,
            initialValue: true
        });

        if (!confirm || p.isCancel(confirm)) {
            p.cancel("Upgrade cancelled.");
            return;
        }

        await ensureInstallerAvailable(installerPath);
        const currentConfig = await readCurrentConfig(installerPath);
        const cwd = path.dirname(installerPath);
        const arch = os.arch();
        const binaryName = `supacloud-linux-${arch === "arm64" ? "arm64" : "amd64"}`;
        const releaseAsset = Array.isArray(data.assets)
            ? data.assets.find((a: Record<string, unknown>) => a.name === binaryName)
            : null;
        const releaseUrl = typeof releaseAsset?.browser_download_url === "string"
            ? releaseAsset.browser_download_url
            : null;

        s.start("Refreshing repository and bootstrap assets");
        await $`git -C ${cwd} fetch --all --tags`.nothrow();
        await $`git -C ${cwd} reset --hard origin/main`;

        if (releaseUrl) {
            s.message(`Downloading latest binary asset: ${binaryName}`);
            await $`mkdir -p ${path.join(cwd, "dist")}`;
            await $`curl -fsSL ${releaseUrl} -o ${path.join(cwd, "dist", binaryName)}`;
        } else {
            logger.warn("[Upgrade] No matching release binary found, install.sh will use existing local artifact or fallback logic.");
        }

        const env = {
            ...process.env,
            ...(currentConfig || {}),
        };

        s.start("Running canonical install.sh upgrade flow");
        const proc = Bun.spawn(["bash", installerPath], {
            cwd,
            stdout: "inherit",
            stderr: "inherit",
            stdin: "inherit",
            env,
        });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            throw new Error(`install.sh exited with code ${exitCode}`);
        }

        p.outro(`🎉 Upgrade successful via canonical install.sh`);
    } catch (error: unknown) {
        s.stop(`Upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
