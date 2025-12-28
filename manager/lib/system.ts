import { deps, exists } from "./deps";
import { BASE_DIR, setComposeCmd, COMPOSE_CMD, AUTH_FILE } from "./config";
import { join } from "node:path";

// Global Admin Password (mutable)
export let ADMIN_PASSWORD = "";

export async function checkAndInstallDockerCompose() {
    try {
        const p = deps.spawn(["docker", "compose", "version"], { stdout: "ignore", stderr: "ignore" });
        if ((await p.exited) === 0) {
            setComposeCmd(["docker", "compose"]);
            return;
        }
    } catch { }

    try {
        const p = deps.spawn(["docker-compose", "version"], { stdout: "ignore", stderr: "ignore" });
        if ((await p.exited) === 0) {
            setComposeCmd(["docker-compose"]);
            return;
        }
    } catch { }
}

export async function initManager() {
    // 1. Garage Config
    const configDir = join(BASE_DIR, "base", "volumes", "garage", "config");
    const configPath = join(configDir, "garage.toml");

    if (!(await exists(configPath))) {
        console.log("Manager: No garage.toml found. Auto-initializing...");

        await deps.mkdir(configDir, { recursive: true });

        const rpcSecret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
        const adminToken = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');

        const tomlContent = `
metadata_dir = "/garage/meta"
data_dir = "/garage/data"
db_engine = "sqlite"

[replication]
mode = "none"

[rpc]
bind_addr = "[::]:3901"
secret = "${rpcSecret}"

[s3_api]
s3_region = "us-east-1"
api_bind_addr = "[::]:3900"
root_domain = ".web.localhost"
index = "index.html"

[admin]
api_bind_addr = "[::]:3903"
admin_token = "${adminToken}"
`;

        await deps.write(configPath, tomlContent);
        console.log("✅ Manager: Generated garage.toml with secure secrets.");
        console.log(`   RPC Secret: ${rpcSecret.substring(0, 8)}...`);
        console.log(`   Admin Token: ${adminToken}`);
        console.log("⚠️  IMPORTANT: Please restart your Base services (docker compose restart garage) to apply these changes!");
    } else {
        console.log("Manager: Found existing garage.toml, skipping auto-init.");
    }

    // 2. Manager Auth
    if (await exists(AUTH_FILE)) {
        ADMIN_PASSWORD = (await deps.file(AUTH_FILE).text()).trim();
    } else {
        const password = process.env.ADMIN_PASSWORD || crypto.randomUUID().substring(0, 8);
        await deps.write(AUTH_FILE, password);
        ADMIN_PASSWORD = password;
        console.log(`Generated Admin Password: ${password}`);
    }
}

export async function startBase() {
    console.log("Starting Base Platform...");
    const proc = deps.spawn([...COMPOSE_CMD, "up", "-d"], {
        cwd: join(BASE_DIR, "base"),
        stdio: ["ignore", "inherit", "inherit"]
    });
    await proc.exited;
    console.log("Base Platform Started.");
}

// Upgrade Logic
import packageJson from "../package.json";
const CURRENT_VERSION = packageJson.version;
const REPO = "zuohuadong/supacloud";

export async function upgradeManager() {
    // Safety check: Don't upgrade if running as source (using bun interpreter)
    if (process.execPath.endsWith("bun") || process.execPath.endsWith("bun.exe")) {
        console.log("⚠️  Running in interpreter mode. Please use 'git pull' to upgrade source code.");
        return;
    }

    console.log(`Checking for updates... (Current: v${CURRENT_VERSION})`);
    try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
        if (!res.ok) {
            if (res.status === 404) {
                console.log("No releases found.");
                return;
            }
            throw new Error(`GitHub API Error: ${res.statusText}`);
        }

        const release = await res.json();
        const latestVersion = release.tag_name.replace(/^v/, '');

        // 1. Check Git SHA (for rolling/latest releases)
        // @ts-ignore defined at build time
        const localSha = process.env.GIT_SHA;
        const remoteSha = release.target_commitish;

        if (localSha && remoteSha) {
            if (localSha === remoteSha) {
                console.log(`✅ You are already on the latest commit (${localSha.substring(0, 7)}).`);
                return;
            }
            console.log(`🔍 New commit found: ${remoteSha.substring(0, 7)} (Local: ${localSha.substring(0, 7)})`);
        } else {
            // 2. Fallback to SemVer Check
            if (latestVersion === CURRENT_VERSION && release.tag_name !== "latest") {
                console.log("✅ You are already on the latest version.");
                return;
            }
        }

        console.log(`🚀 New version found: v${latestVersion}`);


        const targetMap: Record<string, string> = {
            "linux-x64": "supacloud-linux-x64",
            "linux-arm64": "supacloud-linux-arm64",
            "darwin-x64": "supacloud-darwin-x64",
            "darwin-arm64": "supacloud-darwin-arm64",
            "win32-x64": "supacloud-windows-x64.exe"
        };

        const key = `${process.platform}-${process.arch}`;
        const assetName = targetMap[key];

        if (!assetName) {
            console.error(`❌ Auto-upgrade not supported for platform: ${process.platform} (${process.arch})`);
            console.log("Supported targets:", Object.keys(targetMap).join(", "));
            return;
        }

        const asset = release.assets.find((a: any) => a.name === assetName);

        if (!asset) {
            console.error(`❌ No compatible asset '${assetName}' found in release v${latestVersion}`);
            console.log("Available assets:", release.assets.map((a: any) => a.name).join(", "));
            return;
        }

        console.log(`⬇️  Downloading ${asset.browser_download_url}...`);

        const dlRes = await fetch(asset.browser_download_url);
        if (!dlRes.ok) throw new Error("Download failed");

        const buffer = await dlRes.arrayBuffer();
        const binPath = process.execPath;
        const tmpPath = binPath + ".new";
        const backupPath = binPath + ".old";

        // Write new binary
        await deps.write(tmpPath, new Uint8Array(buffer));

        if (process.platform !== "win32") {
            await deps.$`chmod +x ${tmpPath}`;
        }

        // Atomic replacement
        console.log("📦 Installing update...");
        try {
            // Backup current
            await deps.rename(binPath, backupPath);
            // Move new to current
            await deps.rename(tmpPath, binPath);

            // On Windows, specific cleanup might be tricky if process handles linger, 
            // but rename is generally safe for running executables.
            // We leave backupPath there just in case.
        } catch (err) {
            console.error("Failed to replace binary:", err);
            // Try to restore
            try {
                if (await exists(backupPath)) {
                    await deps.rename(backupPath, binPath);
                }
            } catch (restoreErr) {
                console.error("Failed to restore backup:", restoreErr);
            }
            throw err;
        }

        console.log(`✅ Successfully upgraded to v${latestVersion}`);
        console.log("Please restart the service to apply changes.");
        process.exit(0);

    } catch (e) {
        console.error("❌ Upgrade failed:", e);
        process.exit(1);
    }
}
