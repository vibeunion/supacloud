
import { EMBEDDED_ASSETS } from "./assets.gen";
import { $ } from "bun";
import os from "node:os";
import * as p from "@clack/prompts";

const INSTALL_BASE_DIR = "/opt/supacloud";
const CONFIG_FILE = `${INSTALL_BASE_DIR}/config.env`;

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

async function extractAssets() {
    for (const [path, asset] of Object.entries(EMBEDDED_ASSETS)) {
        const targetPath = `${INSTALL_BASE_DIR}/${path.startsWith("/") ? path.substring(1) : path}`;
        // Use Bun.write instead of fs.writeFile, it can handle various buffers and optimize at system level
        const buffer = Buffer.from(asset.content, 'base64');
        await Bun.write(targetPath, buffer);

        if (path.endsWith(".sh") || path.includes("/scripts/")) {
            await $`chmod +x ${targetPath}`;
        }
    }
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
    const isCI = process.env.GITHUB_ACTIONS === "true" || !process.stdout.isTTY;
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
    p.intro("\x1b[45m SupaCloud Unified Node Deployment Bus (Bun Ascension) \x1b[0m");

    const isDryRun = process.argv.includes("--dry-run");
    if (isDryRun) {
        p.log.warn("⚠️ Detected --dry-run flag, will skip actual service installation and system changes.");
    }

    try {
        await checkSystem();
        const s = getSpinner();
        s.start("Base system dehydrated execution state awakening");
        await extractAssets();
        s.stop("SupaCloud control plane binary extracted successfully");

        await performPreFlightChecks(options.forceYes);
        const config = await runInteractiveConfig(options.forceYes);

        if (!isDryRun) {
            p.log.step(">>> Initializing Load Balancer (Angie with ACME) ...");
            // Read from generated config file or sync directly from variables
            // For sync correctness, we destructure config object again (although runInteractiveConfig returns PigstyConfig, it contains the info we need)
            await LoadBalancerManager.installAngie(
                config.studioDomain,
                config.publicDomain,
                // @ts-ignore: SSL options are in install.ts local variables, or read from env vars
                true, // Default enabled
                // @ts-ignore
                "le"
            );
        }

        if (isDryRun) {
            p.log.warn("[Dry Run] Skipping Systemd service registration.");
        } else {
            p.log.step(">>> Registering Management API as system service ...");
            const selfPath = process.argv[0];
            await ServiceManager.register(
                "supacloud",
                "SupaCloud Management API Server",
                selfPath,
                ["start"]
            );
        }

        p.log.success(`🎉 SupaCloud control stack deployment complete`);

        // --- Immediate post-install inspection ---
        const { runDoctor } = await import("./doctor");
        await runDoctor({ forceYes: options.forceYes });
    } catch (error: unknown) {
        p.log.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

import { install as pigstyInstall, type PigstyConfig } from "./infra/pigsty";
import { LoadBalancerManager } from "./infra/loadbalancer";
import { ServiceManager } from "./infra/service";

async function performPreFlightChecks(forceYes = false) {
    const s = getSpinner();
    s.start("Executing environment pre-flight checks");

    // 1. Check critical port occupation
    const ports = [5432, 80, 443, 9090];
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

async function runInteractiveConfig(forceYes = false): Promise<PigstyConfig> {
    const s = getSpinner();

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
                message: 'Enable automatic SSL/HTTPS (via Angie ACME)?',
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
        enableSsl = process.env.ENABLE_SSL !== "false";
        acmeClient = process.env.ACME_CLIENT || 'le';
        p.log.info(`Using config: IP=${internalIp}, Domain=${publicDomain}, Storage=${storageType}, SSL=${enableSsl}`);
    }

    const isTestDomain = publicDomain.includes("nip.io");
    const defaultStudio = isTestDomain ? `studio.${internalIp}.nip.io` : `studio.${publicDomain.replace(/^api\./, '')}`;
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
# Edge Runtime: Bun (built-in)
ENABLE_ANALYTICS="true"
ANALYTICS_BACKEND="postgres"
JWT_SECRET="${jwtSecret}"

# SSL & ACME Sync
ENABLE_SSL="${enableSsl}"
ACME_CLIENT="${acmeClient}"
BASE_DOMAIN="${publicDomain.replace(/^api\./, "")}"
ANGIE_SITES_DIR="/etc/angie/http.d"
KONG_INTERNAL="127.0.0.1:8000"
`;
    await Bun.write(CONFIG_FILE, envContent.trim());
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



