import { $ } from "bun";
import os from "node:os";

export interface PigstyConfig {
    internalIp: string;
    publicDomain: string;
    studioDomain: string;
    dashboardPass: string;
    postgresPass: string;
    grafanaPass: string;
    jwtSecret: string;
    storageType: string;
    force?: boolean;
    anonKey?: string;
    serviceRoleKey?: string;
}

export enum PigstyStatus {
    NOT_INSTALLED = "NOT_INSTALLED",
    DOWNLOADED = "DOWNLOADED",
    CONFIGURED = "CONFIGURED",
    INSTALLED = "INSTALLED",
}

/**
 * Pigsty Core Orchestration Agent Layer
 * Responsible for collecting upstream TS-typed environment parameters,
 * rendering configuration mappings to `pigsty.yml`, and properly scheduling the Ansible environment
 */
export class PigstyManager {
    static async checkStatus(): Promise<PigstyStatus> {
        const home = os.homedir();
        const pigstyDir = `${home}/pigsty`;

        if ((await $`test -f ${home}/.pigsty_installed`.nothrow()).exitCode === 0) {
            return PigstyStatus.INSTALLED;
        }

        if ((await $`test -f ${pigstyDir}/pigsty.yml`.nothrow()).exitCode === 0) {
            // Check if already configured (simple check: whether it contains our IP)
            const content = await Bun.file(`${pigstyDir}/pigsty.yml`).text();
            if (content.includes("SITE_URL") && !content.includes("10.10.10.10")) {
                return PigstyStatus.CONFIGURED;
            }
            return PigstyStatus.DOWNLOADED;
        }

        return PigstyStatus.NOT_INSTALLED;
    }

    /**
     * Execute full download, configuration, and Ansible deployment workflow
     */
    static async install(config: PigstyConfig) {
        const status = await this.checkStatus();
        if (status === PigstyStatus.INSTALLED && !config.force) {
            console.log("[PigstyManager] Pigsty already installed, skipping. Use force: true to reinstall.");
            return;
        }

        console.log(`[PigstyManager] Current status: ${status}, starting deployment...`);
        const home = os.homedir();
        const pigstyDir = `${home}/pigsty`;
        const ymlPath = `${pigstyDir}/pigsty.yml`;
        const backupPath = `${ymlPath}.pre_sc_patch`;

        // 1. Get Pigsty installation directory
        if (status === PigstyStatus.NOT_INSTALLED) {
            console.log("[PigstyManager] Downloading Pigsty release...");
            await $`rm -rf ${pigstyDir}`.nothrow();
            await $`curl -fsSL https://repo.pigsty.io/get | bash`;
        }

        // 2. Execute Bootstrap and template Configure
        if (status === PigstyStatus.NOT_INSTALLED || status === PigstyStatus.DOWNLOADED) {
            console.log("[PigstyManager] Executing initialization and template mapping...");
            // Ensure no .nothrow(), if bootstrap fails must throw exception
            await $`cd ${pigstyDir} && ./bootstrap`;

            await $`cd ${pigstyDir} && ./configure -i ${config.internalIp} -c app/supa`;
        }

        // 3. Map variables into YML (with rollback protection)
        try {
            // Create snapshot
            if (await Bun.file(ymlPath).exists()) {
                await $`cp -f ${ymlPath} ${backupPath}`;
            }

            await this.updatePigstyConfig(config, ymlPath);

            console.log("[PigstyManager] Invoking underlying Ansible Playbooks (this typically takes 10-20 minutes)...");

            let entrypoint = "";
            if ((await $`test -f ${pigstyDir}/deploy.yml`.nothrow()).exitCode === 0) {
                entrypoint = "deploy.yml";
            } else if ((await $`test -f ${pigstyDir}/install.yml`.nothrow()).exitCode === 0) {
                entrypoint = "install.yml";
            } else {
                throw new Error("Cannot find Pigsty executable playbook (deploy.yml or install.yml)");
            }

            const extraArgsArray = await this.getPlaybookExtraArgs();

            // Execute Pigsty Core environment
            console.log(`[PigstyManager] Starting main playbook deployment: ${entrypoint}...`);
            await this.runCommandWithStreaming(
                ["ansible-playbook", entrypoint, ...extraArgsArray],
                pigstyDir
            );

            const isPodman = process.env.CONTAINER_RUNTIME === "podman";
            if (!isPodman && (await $`test -f ${pigstyDir}/docker.yml`.nothrow()).exitCode === 0) {
                console.log("[PigstyManager] Configuring Docker environment...");
                await this.runCommandWithStreaming(
                    ["ansible-playbook", "docker.yml", ...extraArgsArray],
                    pigstyDir
                );
            }

            if ((await $`test -f ${pigstyDir}/app.yml`.nothrow()).exitCode === 0) {
                console.log("[PigstyManager] Starting Supabase integration cluster...");
                await this.runCommandWithStreaming(
                    ["ansible-playbook", "app.yml", ...extraArgsArray],
                    pigstyDir
                );
            }

            // Mark installation successful
            await $`touch ${home}/.pigsty_installed`;
            // Delete backup
            await $`rm -f ${backupPath}`.nothrow();

        } catch (error) {
            console.error("[PigstyManager] Deployment crashed, starting rollback mechanism...");
            if (await Bun.file(backupPath).exists()) {
                await $`mv -f ${backupPath} ${ymlPath}`;
                console.log("[PigstyManager] Restored original pigsty.yml configuration file.");
            }
            throw error;
        }
    }

    /**
     * Use Bun.spawn for streaming output capture
     */
    private static async runCommandWithStreaming(args: string[], cwd: string) {
        const proc = Bun.spawn({
            cmd: args,
            cwd: cwd,
            stdout: "pipe",
            stderr: "pipe",
        });

        let hasFailed = false;
        const reader = async (stream: ReadableStream) => {
            const decoder = new TextDecoder();
            for await (const chunk of stream) {
                const text = decoder.decode(chunk as Uint8Array);
                const lines = text.split("\n").filter(line => line.trim());
                for (const line of lines) {
                    const trimmed = line.trim();
                    console.log(`  [Ansible] ${trimmed}`);
                    // Real-time scan for critical error keywords to prevent exit code misalignment
                    if (trimmed.includes("FAILED!") || trimmed.includes("fatal: [")) {
                        hasFailed = true;
                    }
                }
            }
        };

        await Promise.all([reader(proc.stdout), reader(proc.stderr)]);
        const exitCode = await proc.exited;

        if (exitCode !== 0 || hasFailed) {
            const errorMsg = `Ansible execution failed (Exit Code: ${exitCode}, Failure Detected: ${hasFailed})`;
            console.error(`\n[CRITICAL ERROR] ${errorMsg}`);
            console.error(`[CRITICAL ERROR] Please check the above [Ansible] logs for detailed error stack.\n`);
            throw new Error(errorMsg);
        }
    }

    /**
     * Fine-grained modification of pigsty.yml. Use Bun.file to read entirely and perform safe regex replacement
     */
    private static async updatePigstyConfig(config: PigstyConfig, ymlPath: string) {
            console.log("[PigstyManager] Smart mapping and rewriting target YML settings...");
            let yml = await Bun.file(ymlPath).text();

            // Fix IPs
            yml = yml.replace(/10\.10\.10\.10/g, config.internalIp);
            yml = yml.replace(/10\.6\.0\.9/g, config.internalIp);
            yml = yml.replace(/10\.2\.0\.14/g, config.internalIp);

            // [ROBUST FIX] Only use simple regex to fix some clearly defined Supabase domain parameters
            yml = yml.replace(/SITE_URL: https:\/\/supa.pigsty/g, `SITE_URL: https://${config.studioDomain}`);
            yml = yml.replace(/API_EXTERNAL_URL: https:\/\/supa.pigsty/g, `API_EXTERNAL_URL: https://${config.publicDomain}`);
            yml = yml.replace(/SUPABASE_PUBLIC_URL: https:\/\/supa.pigsty/g, `SUPABASE_PUBLIC_URL: https://${config.publicDomain}`);
            yml = yml.replace(/domain: supa.pigsty/g, `domain: ${config.publicDomain}`);

            // Certbot multiple subdomains
            const certbotDomains = config.publicDomain === config.studioDomain
                ? config.publicDomain
                : `${config.publicDomain},${config.studioDomain}`;
            yml = yml.replace(/certbot: supa.pigsty/g, `certbot: ${certbotDomains}`);

            yml = yml.replace(/supa.pigsty/g, config.publicDomain); // Generic placeholder replacement

            // Passwords and security certificates
            yml = yml.replace(/DASHBOARD_PASSWORD: pigsty/g, `DASHBOARD_PASSWORD: ${config.dashboardPass}`);
            yml = yml.replace(/POSTGRES_PASSWORD: DBUser.Supa/g, `POSTGRES_PASSWORD: ${config.postgresPass}`);
            yml = yml.replace(/password: 'DBUser.Supa'/g, `password: '${config.postgresPass}'`);
            yml = yml.replace(/grafana_admin_password: pigsty/g, `grafana_admin_password: ${config.grafanaPass}`);
            yml = yml.replace(/JWT_SECRET: your-super-secret-jwt-token-with-at-least-32-characters-long/g, `JWT_SECRET: ${config.jwtSecret}`);

            if (config.serviceRoleKey) yml = yml.replace(/SERVICE_ROLE_KEY: .*/g, `SERVICE_ROLE_KEY: ${config.serviceRoleKey}`);

            // Cloud-native storage integration (JuiceFS)
            const storageType = process.env.STORAGE_TYPE || "local";
            const mountPoint = process.env.STORAGE_MOUNT_POINT || "/mnt/supacloud";

            if (storageType === "juicefs") {
                console.log(`[PigstyManager] Switching Supabase Storage backend to JuiceFS: ${mountPoint}`);
                yml = yml.replace(/STORAGE_BACKEND: .*/g, `STORAGE_BACKEND: local`);
                if (yml.includes("STORAGE_LOCAL_ROOTPATH")) {
                    yml = yml.replace(/STORAGE_LOCAL_ROOTPATH: .*/g, `STORAGE_LOCAL_ROOTPATH: ${mountPoint}`);
                } else {
                    yml = yml.replace(/  vars:/, `  vars:\n    STORAGE_LOCAL_ROOTPATH: ${mountPoint}`);
                }
            }

            // --- Multi-node cluster expansion (Phase 6: HA) ---
            const { NodeManager } = await import("./node");
            const nodes = await NodeManager.listNodes();
            if (nodes.length > 0) {
                console.log(`[PigstyManager] Detected ${nodes.length} additional nodes, injecting cluster definition...`);
                const pgNodes = nodes.filter(n => n.role === "pg");
                if (pgNodes.length > 0) {
                    let nodeInjections = "";
                    pgNodes.forEach((node, idx) => {
                        nodeInjections += `    ${node.hostname}: { node_id: ${idx + 2}, ip: ${node.ip} }\n`;
                    });
                    if (yml.includes("pg-test:")) {
                        yml = yml.replace(/pg-test:\s+hosts: \{([^\}]+)\}/, (match, p1) => {
                            return `pg-test:\n  hosts: {${p1.trim()}\n${nodeInjections.trimEnd()}\n  }`;
                        });
                    }
                }
            }

            // --- Nginx deactivation logic (handled by Angie) ---
        if (!yml.includes("nginx_enabled: false")) {
            // Improved injection logic: append if vars: exists, otherwise create it
            if (yml.includes("  vars:")) {
                yml = yml.replace(/^  vars:/m, `  vars:\n    nginx_enabled: false\n    nginx_exporter_enabled: false\n    pgbouncer_max_client_conn: 10000\n    pgbouncer_default_pool_size: 20`);
            } else {
                yml = yml.replace(/^all:/m, `all:\n  vars:\n    nginx_enabled: false\n    nginx_exporter_enabled: false\n    pgbouncer_max_client_conn: 10000\n    pgbouncer_default_pool_size: 20`);
            }
        }

        await Bun.write(ymlPath, yml);
    }

    /**
     * Get extra arguments for Ansible execution
     * Environment adaptive: if container or restricted environment, auto-inject avoidance parameters (node_tune=none, chrony_enabled=false, etc.)
     */
    private static async getPlaybookExtraArgs(): Promise<string[]> {
        const args: string[] = [];

        // 1. Auto-detect environment restrictions
        const isContainer = (await $`test -f /.dockerenv`.nothrow()).exitCode === 0 ||
            process.env.CONTAINER_RUNTIME ||
            process.env.GITHUB_ACTIONS;

        if (isContainer) {
            console.log("[PigstyManager] Detected restricted environment (Container/CI), auto-injecting environment avoidance patches...");
            args.push("-e", "node_tune=none");            // Disable kernel tuning
            args.push("-e", "chrony_enabled=false");      // Block chrony role
            args.push("-e", "node_write_etc_hosts=false"); // Disable modifying read-only hosts
            args.push("-e", "node_dns_method=none");      // Completely disable modifying resolv.conf / hosts
            args.push("-e", "node_repo_remove=true");      // [FIX] Allow cleaning old sources to resolve Conflicting Trusted values
            args.push("-e", JSON.stringify({ node_kernel_modules: [] })); // [FIX] Use JSON format to ensure Ansible recognizes it as a true empty list, skip Task loops
        }

        // 2. Support external environment variable manual injection (preserve extensibility)
        const extra = process.env.SUPACLOUD_ANSIBLE_ARGS;
        if (extra) {
            console.log(`[PigstyManager] Detected extra Ansible parameter injection: ${extra}`);
            args.push(...extra.split(/\s+/).filter(Boolean));
        }

        return args;
    }

    // Removed Debian 12 stabilizeAptSources patch, following best practices to let underlying layer handle
}
