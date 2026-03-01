
import { EMBEDDED_ASSETS } from "./assets.gen";
import { $ } from "bun";
import os from "node:os";
import * as p from "@clack/prompts";

const INSTALL_BASE_DIR = "/opt/supacloud";
const CONFIG_FILE = `${INSTALL_BASE_DIR}/config.env`;

/**
 * 使用 Bun 原生 API 生成安全随机字符串
 */
function generateSecurePassword(length = 24) {
    // Bun 1.x 原生支持生成均匀分布的随机填充，性能优于 node:crypto
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
        // 使用 Bun.write 代替 fs.writeFile，它能处理各种缓冲区并在系统层面进行优化
        const buffer = Buffer.from(asset.content, 'base64');
        await Bun.write(targetPath, buffer);

        if (path.endsWith(".sh") || path.includes("/scripts/")) {
            await $`chmod +x ${targetPath}`;
        }
    }
}


async function checkSystem() {
    if (os.platform() !== "linux") throw new Error("SupaCloud 仅支持 Linux 操作系统。");
    const arch = os.arch();
    if (arch !== "x64" && arch !== "arm64") throw new Error(`不支持的架构: ${arch}。`);
    if (os.userInfo().uid !== 0) throw new Error("请使用 root 权限（sudo）运行安装程序。");
}

/**
 * 判断是否为 CI 环境，如果是则返回静默 Spinner 以避免日志污染
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
    p.intro("\x1b[45m SupaCloud 一体化节点部署总线 (Bun 飞升版) \x1b[0m");

    const isDryRun = process.argv.includes("--dry-run");
    if (isDryRun) {
        p.log.warn("⚠️ 检测到 --dry-run 标志，将跳过实际的服务安装和系统更改。");
    }

    try {
        await checkSystem();
        const s = getSpinner();
        s.start("基座系统脱水执行态唤醒");
        await extractAssets();
        s.stop("SupaCloud 控制面二进制文件解压成功");

        await performPreFlightChecks(options.forceYes);
        const config = await runInteractiveConfig(options.forceYes);
        await prepareSystemEnv();

        if (isDryRun) {
            p.log.warn("[Dry Run] 跳过 Ansible (Pigsty) 剧本执行。");
            p.log.warn("[Dry Run] 跳过 Angie / OpenResty 安装。");
            p.log.warn("[Dry Run] 跳过 Systemd 服务注册。");
        } else {
            p.log.step(">>> 开始转接 Ansible (Pigsty) 剧本列阵 ...");
            await PigstyManager.install(config);

            p.log.step(">>> 开始转接 Angie / OpenResty 前端路由引擎 ...");
            await LoadBalancerManager.installAngie(config.studioDomain, config.publicDomain);

            p.log.step(">>> 正在将 Management API 注册为系统服务 ...");
            const selfPath = process.argv[0];
            await ServiceManager.register(
                "supacloud-api",
                "SupaCloud Management API Server",
                selfPath,
                ["start"]
            );
        }

        p.log.success(`🎉 SupaCloud 控制栈部署完成`);

        // --- 安装后立即巡检 ---
        const { runDoctor } = await import("./doctor");
        await runDoctor({ forceYes: options.forceYes });
    } catch (error: any) {
        p.log.error(`部署崩溃: ${error.message}`);
        process.exit(1);
    }
}

import { PigstyManager, type PigstyConfig } from "./infra/pigsty";
import { LoadBalancerManager } from "./infra/loadbalancer";
import { ServiceManager } from "./infra/service";

async function performPreFlightChecks(forceYes = false) {
    const s = getSpinner();
    s.start("执行环境预检查 (Pre-flight Checks)");

    // 1. 检查关键端口占用
    const ports = [5432, 80, 443, 9090];
    const conflictingPorts = [];
    for (const port of ports) {
        const isOccupied = (await $`ss -tuln | grep :${port} `.nothrow().quiet()).exitCode === 0;
        if (isOccupied) conflictingPorts.push(port);
    }

    if (conflictingPorts.length > 0) {
        s.stop("检测到端口冲突");
        if (!forceYes) {
            const force = await p.confirm({
                message: `检测到关键端口 [${conflictingPorts.join(", ")}] 已被占用，强制继续可能会导致安装失败。是否继续？`,
                initialValue: false
            });
            if (!force || p.isCancel(force)) process.exit(1);
        } else {
            p.log.warn(`检测到关键端口 [${conflictingPorts.join(", ")}] 已被占用，由于开启了非交互模式，将强制继续。`);
        }
    } else {
        s.stop("核心端口可用性验证通过");
    }

    // 2. 检查磁盘空间 (要求至少 10GB)
    s.start("正在评估系统存储容量");
    const dfOutput = await $`df -k /opt | tail -1 | awk '{print $4}'`.text();
    const availableKB = parseInt(dfOutput.trim());
    const availableGB = availableKB / 1024 / 1024;

    if (availableGB < 10) {
        s.stop("磁盘空间较低");
        if (!forceYes) {
            const force = await p.confirm({
                message: `由于 Pigsty 极其庞大，建议至少预留 10GB 空间。当前仅剩 ${availableGB.toFixed(1)}GB，是否强制继续？`,
                initialValue: false
            });
            if (!force || p.isCancel(force)) process.exit(1);
        } else {
            p.log.warn(`磁盘空间较低 (当前仅剩 ${availableGB.toFixed(1)}GB)，由于开启了非交互模式，将强制继续。`);
        }
    } else {
        s.stop(`磁盘空间充足 (剩余 ${availableGB.toFixed(1)}GB)`);
    }
}

async function runInteractiveConfig(forceYes = false): Promise<PigstyConfig> {
    const s = getSpinner();

    // ── 命令行参数解析 ──────────────────────────────────────────────────────────
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

    // 基本 IP 和域名搜集
    s.start("检测系统网络环境");
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
    s.stop(`检测到 ${detectedIps.length} 个可用内网 IP`);

    let internalIp = argIp || "";
    let publicDomain = argDomain || "";
    let storageType = argS3 || "";

    if (!forceYes && (!internalIp || !argDomain || !argS3)) {
        // IP 选择逻辑
        const ipSelection = await p.select({
            message: '请选择或输入服务器内网 IP',
            options: [
                ...detectedIps.map(ip => ({ value: ip, label: ip })),
                { value: 'manual', label: '手动输入...' }
            ],
            initialValue: detectedIps.includes(internalIp || primaryIp) ? (internalIp || primaryIp) : 'manual'
        });

        if (p.isCancel(ipSelection)) process.exit(0);

        if (ipSelection === 'manual') {
            const manualIp = await p.text({
                message: '请输入服务器内网 IP',
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
                message: '请输入 Supabase API 域名',
                initialValue: publicDomain || `api.${internalIp}.nip.io`,
                placeholder: `api.${internalIp}.nip.io`
            }),
            storageType: () => p.select({
                message: '请选择存储后端架构',
                initialValue: storageType as any || 'juicefs',
                options: [
                    { value: 'juicefs', label: 'JuiceFS (推荐: 高性能分布式块存储)' },
                    { value: 'minio', label: 'Minio (标准 S3)' }
                ]
            })
        }, {
            onCancel: () => {
                p.cancel("安装已中止。");
                process.exit(0);
            }
        });
        publicDomain = projectConfig.publicDomain;
        storageType = projectConfig.storageType;
    } else {
        internalIp = internalIp || primaryIp;
        publicDomain = publicDomain || `api.${internalIp}.nip.io`;
        storageType = storageType || 'juicefs';
        p.log.info(`使用配置: IP=${internalIp}, Domain=${publicDomain}, Storage=${storageType}`);
    }

    const isTestDomain = publicDomain.includes("nip.io");
    const defaultStudio = isTestDomain ? `studio.${internalIp}.nip.io` : `studio.${publicDomain.replace(/^api\./, '')}`;
    let studioDomain = argStudio || defaultStudio;

    if (!forceYes && !argStudio) {
        const studioResult = await p.text({
            message: '请输入全局控制台 (Studio) 的域名',
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
            message: "是否随机生成高强度的数据库和面板密码？(极度推荐)",
            initialValue: true
        });
        if (p.isCancel(useAutoPasswords)) process.exit(0);

        if (useAutoPasswords) {
            dbPass = generateSecurePassword(24);
            studioPass = generateSecurePassword(24);
        } else {
            const customPass = await p.group({
                db: () => p.password({ message: "请输入数据库主密码 (供 Postgres/Pigsty 使用)" }),
                studio: () => p.password({ message: "请输入 Studio 面板的超级管理员密码" })
            });
            if (p.isCancel(customPass)) process.exit(0);
            dbPass = customPass.db;
            studioPass = customPass.studio;
        }
    } else {
        p.log.info(`使用提供的统一密码进行配置。`);
    }

    const sEnv = getSpinner();
    sEnv.start("正在加密生成最终配置项结构");
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
EDGE_RUNTIME="deno"
ENABLE_ANALYTICS="true"
ANALYTICS_BACKEND="postgres"
JWT_SECRET="${jwtSecret}"
`;
    await Bun.write(CONFIG_FILE, envContent.trim());
    sEnv.stop("核心配置组落盘完成！");

    p.note(`API 域名: ${publicDomain}\n控制台面: ${studioDomain}\n控制面板密码: ${studioPass}\n数据库密码: ${dbPass}`, "⚠️ 关键凭证 (请截图保存)");

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

async function prepareSystemEnv() {
    const s = getSpinner();
    s.start("基础系统依赖及包管理器预热");

    let isUbuntu = (await $`apt-get --version`.nothrow().quiet()).exitCode === 0;
    if (isUbuntu) {
        await $`apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl tar gzip openssl bc jq git procps openssh-client openssh-server postgresql-client >/dev/null`;
    } else {
        await $`dnf install -y -q curl tar gzip openssl bc jq git procps-ng openssh-clients openssh-server postgresql >/dev/null`;
    }
    s.stop("底层支持组建拉取完毕");

    const totalMemGB = os.totalmem() / 1024 / 1024 / 1024;
    if (totalMemGB < 4.2) {
        s.start(`检测到物理内存较小 (${totalMemGB.toFixed(1)}G)，初始化 4GB Swap`);
        if ((await $`test -f /swapfile`.nothrow().quiet()).exitCode !== 0) {
            await $`fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none`;
            await $`chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile >/dev/null`;
            await $`grep -q "/swapfile" /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab`;
        }
        s.stop("虚拟内存挂载成功");
    }

    s.start("注入无感 SSH 桥接信任凭证 (Ansible Node 需)");
    const homeDir = os.homedir();
    const sshDir = `${homeDir}/.ssh`;
    await $`mkdir -p ${sshDir} && chmod 700 ${sshDir}`;

    if ((await $`test -f ${sshDir}/id_ed25519`.nothrow().quiet()).exitCode !== 0) {
        // 使用 Bun.spawn 显式传递参数数组，彻底解决 Shell 对空参数的解析歧义
        const proc = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", `${sshDir}/id_ed25519`], {
            stdout: "inherit",
            stderr: "inherit"
        });
        await proc.exited;
    }
    const pubKey = (await $`cat ${sshDir}/id_ed25519.pub`.text()).trim();
    await $`grep -q "${pubKey}" ${sshDir}/authorized_keys`.nothrow().quiet();
    if ((await $`grep -q "${pubKey}" ${sshDir}/authorized_keys`.nothrow().quiet()).exitCode !== 0) {
        await $`echo "${pubKey}" >> ${sshDir}/authorized_keys`;
    }
    await $`chmod 600 ${sshDir}/authorized_keys`;
    await $`ssh-keyscan -H localhost 127.0.0.1 ::1 > ${sshDir}/known_hosts 2>/dev/null || true`;
    s.stop("可信通信加密桥搭建成功");
}

