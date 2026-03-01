import { EMBEDDED_ASSETS } from "./assets.gen";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { $ } from "bun";
import os from "node:os";

/**
 * SupaCloud Installer Engine
 * 处理全功能单二进制文件的环境初始化与资源释放
 */

const INSTALL_BASE_DIR = "/opt/supacloud";

async function logStep(msg: string) {
    console.log(`\x1b[34m[STEP]\x1b[0m ${msg}`);
}

async function logInfo(msg: string) {
    console.log(`\x1b[32m[INFO]\x1b[0m ${msg}`);
}

async function logWarn(msg: string) {
    console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`);
}

async function logError(msg: string) {
    console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
}

/**
 * 释放内嵌资源到磁盘
 */
async function extractAssets() {
    await logStep("正在释放内嵌资源...");

    for (const [path, asset] of Object.entries(EMBEDDED_ASSETS)) {
        const targetPath = join(INSTALL_BASE_DIR, path.startsWith("/") ? path.substring(1) : path);
        await mkdir(dirname(targetPath), { recursive: true });

        const buffer = Buffer.from(asset.content, 'base64');
        await writeFile(targetPath, buffer);

        // 如果是脚本，增加执行权限
        if (path.endsWith(".sh") || path.includes("/scripts/")) {
            await chmod(targetPath, 0o755);
        }
    }

    await logInfo(`资源已释放至: ${INSTALL_BASE_DIR}`);
}

/**
 * 检查操作系统兼容性 (翻译自 install.sh:check_os_compatibility)
 */
async function checkSystem() {
    await logStep("检查系统要求与兼容性...");

    if (os.platform() !== "linux") {
        throw new Error("SupaCloud 目前仅支持 Linux 操作系统。");
    }

    const arch = os.arch();
    if (arch !== "x64" && arch !== "arm64") {
        throw new Error(`不支持的架构: ${arch}。仅支持 x86_64 和 aarch64。`);
    }

    // 检查 root 权限
    const uid = os.userInfo().uid;
    if (uid !== 0) {
        throw new Error("请使用 root 权限（sudo）运行安装程序。");
    }

    await logInfo(`系统检查通过: Linux ${arch} (root)`);
}

/**
 * 环境初始化逻辑 (翻译自 install.sh:install_base_dependencies, setup_swap, setup_local_ssh)
 */
async function initializeEnvironment() {
    await logStep("正在初始化系统环境（依赖、Swap、SSH）...");

    // 1. 安装基础依赖
    await logInfo("更新系统并安装基础依赖...");
    if ((await $`command -v dnf &>/dev/null`).exitCode === 0) {
        await $`dnf install -y curl tar gzip openssl bc jq git procps-ng openssh-clients openssh-server`;
    } else if ((await $`command -v apt-get &>/dev/null`).exitCode === 0) {
        await $`apt-get update && apt-get install -y curl tar gzip openssl bc jq git procps openssh-client openssh-server`;
    }

    // 2. 配置 Swap (如果内存 < 4GB)
    const totalMemByte = os.totalmem();
    const totalMemGB = totalMemByte / 1024 / 1024 / 1024;

    if (totalMemGB < 4.2) {
        await logWarn(`检测到物理内存较小 (${totalMemGB.toFixed(2)}GB)，正在创建 4GB Swap...`);
        if ((await $`ls /swapfile &>/dev/null`).exitCode !== 0) {
            await $`fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096`;
            await $`chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile`;
            await $`grep -q "/swapfile" /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab`;
        }
        await logInfo("Swap 配置完成");
    }

    // 3. 配置本地 SSH 免密 (Ansible 必需)
    await logInfo("配置本地 SSH 免密登录...");
    const homeDir = os.homedir();
    const sshDir = join(homeDir, ".ssh");
    await mkdir(sshDir, { recursive: true, mode: 0o700 });

    if ((await $`ls ${sshDir}/id_ed25519 &>/dev/null`).exitCode !== 0) {
        await $`ssh-keygen -t ed25519 -N "" -f ${sshDir}/id_ed25519`;
    }

    const pubKey = (await $`cat ${sshDir}/id_ed25519.pub`.text()).trim();
    await $`grep -q "${pubKey}" ${sshDir}/authorized_keys &>/dev/null || echo "${pubKey}" >> ${sshDir}/authorized_keys`;
    await chmod(join(sshDir, "authorized_keys"), 0o600);

    // 基础防火墙/安全策略微调
    await $`ssh-keyscan -H localhost 127.0.0.1 ::1 > ${sshDir}/known_hosts 2>/dev/null || true`;

    await logInfo("系统环境初始化完成");
}

/**
 * 核心安装入口
 */
export async function runInstall() {
    console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║          SupaCloud Unified Installer (CLI)                ║
  ║          "One File to Rule Them All"                      ║
  ╚═══════════════════════════════════════════════════════════╝
  `);

    try {
        await checkSystem();
        await extractAssets();
        await initializeEnvironment();

        // 下一步：调用释放出来的 infra/angie/setup.sh 和 setup.sh
        await logStep("正在启动基础设施部署 (Pigsty/Angie)...");

        // 设置环境变量
        process.env.INTERNAL_IP = process.env.INTERNAL_IP || (await $`hostname -I | awk '{print $1}'`.text()).trim();

        const setupScript = join(INSTALL_BASE_DIR, "setup.sh");
        await logInfo("执行底层部署脚本...");

        // 通过 Bun 子进程调用 Bash 脚本完成重型部署任务
        await $`bash ${setupScript} --s3 juicefs`.inherit();

        await logInfo("============================================================");
        await logInfo("SupaCloud 核心环境部署成功！");
        await logInfo(`请访问控制台: http://${process.env.INTERNAL_IP}:9090`);
        await logInfo("============================================================");

    } catch (error: any) {
        await logError(`安装失败: ${error.message}`);
        process.exit(1);
    }
}
