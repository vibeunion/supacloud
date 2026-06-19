
import { $ } from "bun";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { config as appConfig } from "./config";

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

/**
 * Generate secure random string using Bun native API
 */
function generateSecurePassword(length = 24) {
    // Bun 1.x natively supports generating uniformly distributed random padding, better performance than node:crypto
    const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let ret = '';
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i++) {
        ret += charset[bytes[i] % charset.length];
    }
    return ret;
}

function deriveBaseDomain(domain: string) {
    return domain.trim().replace(/^(?:api|studio)\./i, "");
}

function deriveStudioDomain(apiDomain: string, internalIp: string) {
    if (!apiDomain.trim()) return `studio.${internalIp}.nip.io`;
    return `studio.${deriveBaseDomain(apiDomain)}`;
}

async function ensureInstallerAvailable(installerPath: string) {
    await $`chmod +x ${installerPath}`.quiet();
}


async function checkSystem() {
    if (os.platform() !== "linux") throw new Error("SupaCloud only supports Linux operating systems.");
    const arch = os.arch();
    if (arch !== "x64" && arch !== "arm64") throw new Error(`Unsupported architecture: ${arch}.`);
    if (os.userInfo().uid !== 0) throw new Error("Please run the installer with root privileges (sudo).");
}

/**
 * Determine if CI environment, return silent Spinner if so to avoid log pollution
 */
function getSpinner() {
    const s = p.spinner();
    const isCI = appConfig.isGithubActions || !process.stdout.isTTY;
    if (isCI) {
        return {
            start: (msg: string) => console.log(`[CI] ${msg}...`),
            stop: (msg: string) => console.log(`[CI] ✅ ${msg}`),
            message: (msg: string) => console.log(`[CI] ${msg}`)
        };
    }
    return s;
}

export async function runInstall(options: { forceYes?: boolean } = {}) {
    p.intro("\x1b[45m SupaCloud Installer \x1b[0m");

    const isDryRun = process.argv.includes("--dry-run");
    const installerPath = resolveInstallerPath();

    try {
        await checkSystem();

        if (!installerPath) {
            throw new Error("install.sh not found. Please run from the repository root or install to /opt/supacloud first.");
        }

        await ensureInstallerAvailable(installerPath);
        await performPreFlightChecks(options.forceYes);
        const config = await runInteractiveConfig(installerPath, options.forceYes);

        if (isDryRun) {
            p.log.warn("[Dry Run] install.sh will not be executed.");
            p.log.info(`Prepared config at ${getConfigFilePath(installerPath)}`);
            return;
        }

        p.log.step(`>>> Running canonical installer: ${installerPath}`);
        const args = ["--ip", config.internalIp, "--domain", config.publicDomain, "--studio", config.studioDomain, "--s3", config.storageType, "--password", config.postgresPass];
        const proc = Bun.spawn(["bash", installerPath, ...args], {
            cwd: path.dirname(installerPath),
            stdout: "inherit",
            stderr: "inherit",
            stdin: "inherit",
            env: {
                ...process.env,
                EDGE_RUNTIME: "bun",
                EDGE_RUNTIME_MODE: process.env.EDGE_RUNTIME_MODE || "embedded",
                S3_STORAGE_TYPE: config.storageType,
                INTERNAL_IP: config.internalIp,
                SUPABASE_PUBLIC_DOMAIN: config.publicDomain,
                SUPABASE_STUDIO_DOMAIN: config.studioDomain,
                POSTGRES_PASSWORD: config.postgresPass,
                DASHBOARD_PASSWORD: config.dashboardPass,
                GRAFANA_PASSWORD: config.grafanaPass,
                JWT_SECRET: config.jwtSecret,
            },
        });
        const exitCode = await proc.exited;
        if (exitCode !== 0) {
            throw new Error(`install.sh exited with code ${exitCode}`);
        }

        p.log.success(`🎉 SupaCloud installation complete via canonical install.sh`);
    } catch (error: unknown) {
        p.log.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

import type { PigstyConfig } from "./infra/pigsty";

async function performPreFlightChecks(forceYes = false) {
    const s = getSpinner();
    s.start("Executing environment pre-flight checks");

    // 1. Check critical port occupation
    const ports = [5432, 80, 443, 8080, 9090];
    const conflictingPorts = [];
    for (const port of ports) {
        const isOccupied = (await $`ss -tuln | grep :${port} `.nothrow().quiet()).exitCode === 0;
        if (isOccupied) conflictingPorts.push(port);
    }

    if (conflictingPorts.length > 0) {
        s.stop("Detected port conflicts");
        if (!forceYes) {
            const force = await p.confirm({
                message: `Critical ports [${conflictingPorts.join(", ")}] are already occupied, forcing continue may cause installation failure. Continue?`,
                initialValue: false
            });
            if (!force || p.isCancel(force)) process.exit(1);
        } else {
            p.log.warn(`Critical ports [${conflictingPorts.join(", ")}] are already occupied, due to non-interactive mode, will force continue.`);
        }
    } else {
        s.stop("Core port availability verified");
    }

    // 2. Check disk space (require at least 10GB)
    s.start("Evaluating system storage capacity");
    const dfOutput = await $`df -k /opt | tail -1 | awk '{print $4}'`.text();
    const availableKB = parseInt(dfOutput.trim());
    const availableGB = availableKB / 1024 / 1024;

    if (availableGB < 10) {
        s.stop("Low disk space");
        if (!forceYes) {
            const force = await p.confirm({
                message: `Since Pigsty is extremely large, at least 10GB is recommended. Currently only ${availableGB.toFixed(1)}GB remaining, force continue?`,
                initialValue: false
            });
            if (!force || p.isCancel(force)) process.exit(1);
        } else {
            p.log.warn(`Low disk space (currently only ${availableGB.toFixed(1)}GB remaining), due to non-interactive mode, will force continue.`);
        }
    } else {
        s.stop(`Sufficient disk space (${availableGB.toFixed(1)}GB remaining)`);
    }
}

async function runInteractiveConfig(installerPath: string, forceYes = false): Promise<PigstyConfig> {
    const s = getSpinner();
    const configFile = getConfigFilePath(installerPath);

    // ── Command line argument parsing ──────────────────────────────────────────────────────────
    const args = process.argv.slice(2);
    const getArg = (name: string) => {
        const index = args.indexOf(name);
        return (index !== -1 && index + 1 < args.length) ? args[index + 1] : null;
    };

    const argIp = getArg("--ip");
    const argDomain = getArg("--domain");
    const argStudio = getArg("--studio");
    const argS3 = getArg("--s3");
    const argPassword = getArg("--password");

    // Basic IP and domain collection
    s.start("Detecting system network environment");
    const interfaces = os.networkInterfaces();
    const detectedIps: string[] = [];
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                detectedIps.push(iface.address);
            }
        }
    }
    const primaryIp = detectedIps[0] || "127.0.0.1";
    s.stop(`Detected ${detectedIps.length} available internal IPs`);

    let internalIp = argIp || "";
    let publicDomain = argDomain || "";
    let storageType = argS3 || "";
    let enableSsl = true;
    let acmeClient = "le";

    if (!forceYes && (!internalIp || !argDomain || !argS3)) {
        // IP selection logic
        const ipSelection = await p.select({
            message: 'Select or enter server internal IP',
            options: [
                ...detectedIps.map(ip => ({ value: ip, label: ip })),
                { value: 'manual', label: 'Manual input...' }
            ],
            initialValue: detectedIps.includes(internalIp || primaryIp) ? (internalIp || primaryIp) : 'manual'
        });

        if (p.isCancel(ipSelection)) process.exit(0);

        if (ipSelection === 'manual') {
            const manualIp = await p.text({
                message: 'Enter server internal IP',
                initialValue: internalIp || primaryIp,
                placeholder: internalIp || primaryIp
            });
            if (p.isCancel(manualIp)) process.exit(0);
            internalIp = manualIp;
        } else {
            internalIp = ipSelection as string;
        }

        const projectConfig = await p.group({
            publicDomain: () => p.text({
                message: 'Enter Supabase API domain',
                initialValue: publicDomain || `api.${internalIp}.nip.io`,
                placeholder: `api.${internalIp}.nip.io`
            }),
            storageType: () => p.select({
                message: 'Select storage backend architecture',
                initialValue: storageType as string || 'juicefs',
                options: [
                    { value: 'juicefs', label: 'JuiceFS (Recommended: High-performance distributed block storage)' },
                    { value: 'minio', label: 'Minio (Standard S3)' }
                ]
            }),
            enableSsl: () => p.confirm({
                message: 'Enable automatic SSL/HTTPS (via Caddy Automatic HTTPS)?',
                initialValue: true
            }),
            acmeClient: ({ results }) => results.enableSsl ? p.select({
                message: 'Select ACME Directory Issuer',
                initialValue: 'le',
                options: [
                    { value: 'le', label: "Let's Encrypt (Production)" },
                    { value: 'le_staging', label: "Let's Encrypt (Staging/Test)" },
                    { value: 'zerossl', label: "ZeroSSL" }
                ]
            }) : Promise.resolve('le')
        }, {
            onCancel: () => {
                p.cancel("Installation aborted.");
                process.exit(0);
            }
        });
        publicDomain = projectConfig.publicDomain as string;
        storageType = projectConfig.storageType as string;
        enableSsl = projectConfig.enableSsl as boolean;
        acmeClient = (projectConfig.acmeClient as string) || 'le';
    } else {
        internalIp = internalIp || primaryIp;
        publicDomain = publicDomain || `api.${internalIp}.nip.io`;
        storageType = storageType || 'juicefs';
        enableSsl = appConfig.enableSsl;
        acmeClient = appConfig.acmeClient;
        p.log.info(`Using config: IP=${internalIp}, Domain=${publicDomain}, Storage=${storageType}, SSL=${enableSsl}`);
    }

    const defaultStudio = deriveStudioDomain(publicDomain, internalIp);
    let studioDomain = argStudio || defaultStudio;

    if (!forceYes && !argStudio) {
        const studioResult = await p.text({
            message: 'Enter global console (Studio) domain',
            initialValue: studioDomain,
            placeholder: studioDomain
        });
        if (p.isCancel(studioResult)) process.exit(0);
        studioDomain = studioResult;
    }

    let dbPass = argPassword || "";
    let studioPass = argPassword || "";

    if (!forceYes || !argPassword) {
        const useAutoPasswords = await p.confirm({
            message: "Randomly generate strong database and dashboard passwords? (Highly recommended)",
            initialValue: true
        });
        if (p.isCancel(useAutoPasswords)) process.exit(0);

        if (useAutoPasswords) {
            dbPass = generateSecurePassword(24);
            studioPass = generateSecurePassword(24);
        } else {
            const customPass = await p.group({
                db: () => p.password({ message: "Enter database master password (for Postgres/Pigsty)" }),
                studio: () => p.password({ message: "Enter Studio dashboard super admin password" })
            });
            if (p.isCancel(customPass)) process.exit(0);
            dbPass = customPass.db;
            studioPass = customPass.studio;
        }
    } else {
        p.log.info(`Using provided unified password for configuration.`);
    }

    const sEnv = getSpinner();
    sEnv.start("Encrypting and generating final configuration structure");
    const jwtSecret = generateSecurePassword(40);
    const envContent = `
# SupaCloud Unified Configuration
INTERNAL_IP="${internalIp}"
SUPABASE_PUBLIC_DOMAIN="${publicDomain}"
SUPABASE_STUDIO_DOMAIN="${studioDomain}"

DASHBOARD_USERNAME="admin"
DASHBOARD_PASSWORD="${studioPass}"
POSTGRES_PASSWORD="${dbPass}"
GRAFANA_PASSWORD="${dbPass}"

SWAP_SIZE_GB="4"
PG_VERSION="18"
S3_STORAGE_TYPE="${storageType}"
TUS_MAX_SIZE="524288000"
TUS_MAX_CHUNK_SIZE="16777216"
PIGSTY_CONFIG_TEMPLATE="supabase"
SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK="false"
SUPACLOUD_MIGRATE_LEGACY_SUPABASE_COMPOSE="false"
IMAGINARY_IMAGE="h2non/imaginary:1.2.4"
# Edge Runtime: Bun (built-in)
ENABLE_ANALYTICS="true"
ANALYTICS_BACKEND="postgres"
JWT_SECRET="${jwtSecret}"

# SSL & ACME Sync
ENABLE_SSL="${enableSsl}"
ACME_CLIENT="${acmeClient}"
BASE_DOMAIN="${deriveBaseDomain(publicDomain)}"
LEGO_BIN="lego"
ACME_STATE_DIR="/var/lib/supacloud/lego"
ACME_HTTP_WEBROOT="/var/lib/supacloud/acme-challenges"
CADDY_ADMIN_URL="http://127.0.0.1:2019"
CADDY_CONFIG_PATH="/etc/supacloud/caddy/config.json"
CADDY_STATE_DIR="/var/lib/supacloud/caddy"
CADDY_BINARY_PATH="/usr/local/bin/supacloud-caddy"
`;
    await Bun.write(configFile, envContent.trim());
    sEnv.stop("Core configuration group persisted!");

    p.note(`API Domain: ${publicDomain}\nConsole: ${studioDomain}\nDashboard Password: ${studioPass}\nDatabase Password: ${dbPass}`, "⚠️ Key Credentials (Please screenshot to save)");

    return {
        internalIp: internalIp,
        publicDomain: publicDomain,
        studioDomain: studioDomain,
        dashboardPass: studioPass,
        postgresPass: dbPass,
        grafanaPass: dbPass,
        jwtSecret: jwtSecret,
        storageType: storageType,
    };
}
