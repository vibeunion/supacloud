import { $ } from "bun";
import os from "node:os";
import path from "node:path";
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import * as p from "@clack/prompts";
import { config as appConfig, loadedConfigFileEnvKeys } from "./config";
import type { PigstyConfig } from "./infra/pigsty";

const INSTALL_BASE_DIR = "/opt/supacloud";

export const INSTALL_INPUT_KEYS = [
    "INTERNAL_IP",
    "SUPABASE_PUBLIC_DOMAIN",
    "SUPABASE_STUDIO_DOMAIN",
    "SUPABASE_DOMAIN",
    "DASHBOARD_USERNAME",
    "DASHBOARD_PASSWORD",
    "POSTGRES_PASSWORD",
    "GRAFANA_PASSWORD",
    "JWT_SECRET",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "SWAP_SIZE_GB",
    "PG_VERSION",
    "PIGSTY_VERSION",
    "TIMEZONE",
    "PIGSTY_CONFIG_TEMPLATE",
    "SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK",
    "SUPACLOUD_MIGRATE_LEGACY_SUPABASE_COMPOSE",
    "S3_STORAGE_TYPE",
    "JUICEFS_BACKEND",
    "S3_ENDPOINT",
    "S3_PROTOCOL",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "S3_FORCE_PATH_STYLE",
    "EXTERNAL_S3_ENDPOINT",
    "EXTERNAL_S3_REGION",
    "EXTERNAL_S3_BUCKET",
    "EXTERNAL_S3_ACCESS_KEY",
    "EXTERNAL_S3_SECRET_KEY",
    "IMAGINARY_IMAGE",
    "EDGE_RUNTIME",
    "ENABLE_ANALYTICS",
    "ANALYTICS_BACKEND",
    "LOGFLARE_DB",
    "LOGFLARE_SCHEMA",
    "LOGFLARE_ERL_FLAGS",
] as const;

export type InstallInputKey = typeof INSTALL_INPUT_KEYS[number];
export type InstallInputValues = Partial<Record<InstallInputKey, string>>;
export type InstallArtifactPolicy = {
    mode: "local" | "release";
    forceVerified: boolean;
};

export function resolveInstallArtifactPolicy(
    env: Record<string, string | undefined> = process.env,
): InstallArtifactPolicy {
    const requestedMode = env.SUPACLOUD_SETUP_ARTIFACT_MODE || undefined;
    if (requestedMode !== undefined && requestedMode !== "local" && requestedMode !== "release") {
        throw new Error("SUPACLOUD_SETUP_ARTIFACT_MODE must be local or release");
    }
    const requestedForce = env.SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS;
    if (requestedForce !== undefined && requestedForce !== "" && requestedForce !== "true" && requestedForce !== "false") {
        throw new Error("SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS must be true or false");
    }
    const forced = requestedForce === "true";
    if (forced && requestedMode === "local") {
        throw new Error("Forced verified release assets cannot be combined with local artifact mode");
    }
    const mode = forced ? "release" : requestedMode || "local";
    return { mode, forceVerified: mode === "release" };
}

function resolveInstallerPath() {
    const candidates = [
        path.join(process.cwd(), "install.sh"),
        path.join(INSTALL_BASE_DIR, "install.sh")
    ];
    return candidates.find(candidate => existsSync(candidate)) || null;
}

export function getConfigFilePath(
    _installerPath: string,
    env: Record<string, string | undefined> = process.env,
) {
    return env.SUPACLOUD_INSTALL_CONFIG_FILE || "/etc/supabase/install.env";
}

function resolveInstallConfigHelper(installerPath: string): string | null {
    const installerDir = path.dirname(installerPath);
    const candidates = [
        path.join(installerDir, "scripts/lib/install_config.sh"),
        "/opt/supacloud/scripts/lib/install_config.sh",
        path.join(process.cwd(), "scripts/lib/install_config.sh"),
    ];
    return candidates.find(candidate => existsSync(candidate)) || null;
}

export function readInstallInputValues(configFile: string, installerPath: string): InstallInputValues {
    if (!existsSync(configFile)) return {};
    const helper = resolveInstallConfigHelper(installerPath);
    if (!helper) {
        throw new Error("scripts/lib/install_config.sh is required to safely parse existing install input");
    }
    const command = 'source "$1"; shift; supacloud_parse_install_input "$1" "$@"';
    const result = Bun.spawnSync([
        "bash",
        "-c",
        command,
        "_",
        helper,
        configFile,
        ...INSTALL_INPUT_KEYS,
    ], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) {
        throw new Error(`Invalid install input: ${Buffer.from(result.stderr).toString("utf8").trim()}`);
    }
    const parsed: InstallInputValues = {};
    for (const line of Buffer.from(result.stdout).toString("utf8").split("\n")) {
        if (!line) continue;
        const separator = line.indexOf("\t");
        if (separator <= 0) continue;
        const key = line.slice(0, separator) as InstallInputKey;
        if (!INSTALL_INPUT_KEYS.includes(key)) continue;
        parsed[key] = Buffer.from(line.slice(separator + 1), "base64").toString("utf8");
    }
    return parsed;
}

export function mergeInstallInputValues(
    existing: InstallInputValues,
    explicit: InstallInputValues,
    generatedDefaults: InstallInputValues,
): InstallInputValues {
    const merged: InstallInputValues = {};
    for (const key of INSTALL_INPUT_KEYS) {
        const value = explicit[key] ?? existing[key] ?? generatedDefaults[key];
        if (value !== undefined) merged[key] = value;
    }
    return merged;
}

function quoteInstallInputValue(value: string): string {
    if (value.includes("\0") || value.includes("\r") || value.includes("\n")) {
        throw new Error("Install input values must be single-line strings");
    }
    return `"${value
        .replaceAll("\\", "\\\\")
        .replaceAll('"', '\\"')
        .replaceAll("$", "\\$")
        .replaceAll("`", "\\`")}"`;
}

export function writeInstallInputAtomic(configFile: string, values: InstallInputValues): void {
    mkdirSync(path.dirname(configFile), { recursive: true });
    const temporaryFile = `${configFile}.tmp-${process.pid}-${crypto.randomUUID()}`;
    let descriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    try {
        descriptor = openSync(temporaryFile, "wx", 0o600);
        const payload = INSTALL_INPUT_KEYS
            .filter(key => values[key] !== undefined)
            .map(key => `${key}=${quoteInstallInputValue(values[key]!)}`)
            .join("\n") + "\n";
        writeFileSync(descriptor, payload, "utf8");
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporaryFile, configFile);
        chmodSync(configFile, 0o600);
        directoryDescriptor = openSync(path.dirname(configFile), "r");
        fsyncSync(directoryDescriptor);
        closeSync(directoryDescriptor);
        directoryDescriptor = undefined;
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
        rmSync(temporaryFile, { force: true });
    }
}

function collectExplicitInstallInput(args: string[]): InstallInputValues {
    const explicit: InstallInputValues = {};
    for (const key of INSTALL_INPUT_KEYS) {
        if (loadedConfigFileEnvKeys.has(key)) continue;
        const value = process.env[key];
        if (value !== undefined) explicit[key] = value;
    }

    const getArg = (name: string): string | undefined => {
        const index = args.indexOf(name);
        return index !== -1 && index + 1 < args.length ? args[index + 1] : undefined;
    };
    const cliMappings = [
        ["--ip", "INTERNAL_IP"],
        ["--domain", "SUPABASE_PUBLIC_DOMAIN"],
        ["--studio", "SUPABASE_STUDIO_DOMAIN"],
        ["--s3", "S3_STORAGE_TYPE"],
    ] as const;
    for (const [flag, key] of cliMappings) {
        const value = getArg(flag);
        if (value !== undefined) explicit[key] = value;
    }
    const password = getArg("--password");
    if (password !== undefined) {
        explicit.POSTGRES_PASSWORD = password;
        explicit.DASHBOARD_PASSWORD = password;
        explicit.GRAFANA_PASSWORD = password;
    }
    return explicit;
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

        if (!isDryRun) {
            await ensureInstallerAvailable(installerPath);
        }
        await performPreFlightChecks(options.forceYes);
        const config = await runInteractiveConfig(installerPath, options.forceYes, {
            persist: !isDryRun,
        });

        if (isDryRun) {
            p.log.warn("[Dry Run] install.sh will not be executed.");
            p.log.info(`Install input would be written to ${getConfigFilePath(installerPath)} during a real install.`);
            return;
        }

        if (!isDryRun) {
            p.log.step(`>>> Running canonical installer: ${installerPath}`);
            const artifactPolicy = resolveInstallArtifactPolicy();
            const args = [
                "--ip", config.internalIp,
                "--domain", config.publicDomain,
                "--studio", config.studioDomain,
                "--s3", config.storageType,
            ];
            const proc = Bun.spawn(["bash", installerPath, ...args], {
                cwd: path.dirname(installerPath),
                stdout: "inherit",
                stderr: "inherit",
                stdin: "inherit",
                env: {
                    ...process.env,
                    SUPACLOUD_SETUP_ARTIFACT_MODE: artifactPolicy.mode,
                    SUPACLOUD_FORCE_VERIFIED_RELEASE_ASSETS:
                        artifactPolicy.forceVerified ? "true" : "false",
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
        }

        p.log.success(`🎉 SupaCloud installation complete via canonical install.sh`);
    } catch (error: unknown) {
        p.log.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

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

async function runInteractiveConfig(
    installerPath: string,
    forceYes = false,
    options: { persist?: boolean } = {},
): Promise<PigstyConfig> {
    const s = getSpinner();
    const configFile = getConfigFilePath(installerPath);
    const args = process.argv.slice(2);
    const persisted = readInstallInputValues(configFile, installerPath);
    const explicit = collectExplicitInstallInput(args);
    const configured = mergeInstallInputValues(persisted, explicit, {});

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

    let internalIp = configured.INTERNAL_IP || "";
    let publicDomain = configured.SUPABASE_PUBLIC_DOMAIN || configured.SUPABASE_DOMAIN || "";
    let storageType = configured.S3_STORAGE_TYPE || "";
    let enableSsl = true;
    let acmeClient = "le";

    if (!forceYes && (!internalIp || !publicDomain || !storageType)) {
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
                    { value: 'minio', label: 'Minio (Standard S3)' },
                    { value: 'external', label: 'External S3-compatible storage' }
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
    let studioDomain = configured.SUPABASE_STUDIO_DOMAIN || "";

    if (!forceYes && !studioDomain) {
        const studioResult = await p.text({
            message: 'Enter global console (Studio) domain',
            initialValue: defaultStudio,
            placeholder: defaultStudio
        });
        if (p.isCancel(studioResult)) process.exit(0);
        studioDomain = studioResult;
    }
    studioDomain = studioDomain || defaultStudio;

    let dbPass = configured.POSTGRES_PASSWORD || "";
    let studioPass = configured.DASHBOARD_PASSWORD || "";

    if (forceYes) {
        dbPass = dbPass || generateSecurePassword(24);
        studioPass = studioPass || generateSecurePassword(24);
    } else if (!dbPass || !studioPass) {
        const useAutoPasswords = await p.confirm({
            message: "Randomly generate strong database and dashboard passwords? (Highly recommended)",
            initialValue: true
        });
        if (p.isCancel(useAutoPasswords)) process.exit(0);

        if (useAutoPasswords) {
            dbPass = dbPass || generateSecurePassword(24);
            studioPass = studioPass || generateSecurePassword(24);
        } else {
            if (!dbPass) {
                const customDatabasePassword = await p.password({
                    message: "Enter database master password (for Postgres/Pigsty)",
                });
                if (p.isCancel(customDatabasePassword)) process.exit(0);
                dbPass = customDatabasePassword;
            }
            if (!studioPass) {
                const customStudioPassword = await p.password({
                    message: "Enter Studio dashboard super admin password",
                });
                if (p.isCancel(customStudioPassword)) process.exit(0);
                studioPass = customStudioPassword;
            }
        }
    }

    const sEnv = getSpinner();
    sEnv.start("Resolving installation input");
    const jwtSecret = configured.JWT_SECRET || generateSecurePassword(40);
    const interactiveValues: InstallInputValues = {
        INTERNAL_IP: internalIp,
        SUPABASE_PUBLIC_DOMAIN: publicDomain,
        SUPABASE_STUDIO_DOMAIN: studioDomain,
        DASHBOARD_USERNAME: configured.DASHBOARD_USERNAME || "admin",
        DASHBOARD_PASSWORD: studioPass,
        POSTGRES_PASSWORD: dbPass,
        GRAFANA_PASSWORD: configured.GRAFANA_PASSWORD || dbPass,
        JWT_SECRET: jwtSecret,
        SWAP_SIZE_GB: configured.SWAP_SIZE_GB || "4",
        PG_VERSION: configured.PG_VERSION || "18",
        PIGSTY_VERSION: configured.PIGSTY_VERSION || "latest",
        TIMEZONE: configured.TIMEZONE || "Asia/Shanghai",
        PIGSTY_CONFIG_TEMPLATE: configured.PIGSTY_CONFIG_TEMPLATE || "supabase",
        SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK:
            configured.SUPACLOUD_INSTALL_LEGACY_SUPABASE_STACK || "false",
        SUPACLOUD_MIGRATE_LEGACY_SUPABASE_COMPOSE:
            configured.SUPACLOUD_MIGRATE_LEGACY_SUPABASE_COMPOSE || "false",
        S3_STORAGE_TYPE: storageType,
        JUICEFS_BACKEND: configured.JUICEFS_BACKEND || "postgres",
        IMAGINARY_IMAGE: configured.IMAGINARY_IMAGE || "h2non/imaginary:1.2.4",
        ENABLE_ANALYTICS: configured.ENABLE_ANALYTICS || "true",
        ANALYTICS_BACKEND: configured.ANALYTICS_BACKEND || "postgres",
        LOGFLARE_DB: configured.LOGFLARE_DB || "_supabase",
        LOGFLARE_SCHEMA: configured.LOGFLARE_SCHEMA || "_analytics",
        LOGFLARE_ERL_FLAGS: configured.LOGFLARE_ERL_FLAGS || "+P 32768 +Q 4096 +S 2:2 +hms 64 +hmbs 64 +e 128 +L",
    };
    const resolvedInput = mergeInstallInputValues(persisted, {
        ...explicit,
        ...interactiveValues,
    }, {});
    if (options.persist !== false) {
        writeInstallInputAtomic(configFile, resolvedInput);
        sEnv.stop("Installation input persisted securely");
    } else {
        sEnv.stop("Installation input resolved without writing files");
    }

    p.note(
        `API Domain: ${publicDomain}\nConsole: ${studioDomain}\nInstall input: ${configFile}`,
        "Installation configuration",
    );

    return {
        internalIp: internalIp,
        publicDomain: publicDomain,
        studioDomain: studioDomain,
        dashboardPass: studioPass,
        postgresPass: dbPass,
        grafanaPass: resolvedInput.GRAFANA_PASSWORD || dbPass,
        jwtSecret: jwtSecret,
        storageType: storageType,
    };
}
