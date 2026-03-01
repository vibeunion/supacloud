import { $ } from "bun";
import os from "node:os";
import { chmod, rename, unlink } from "node:fs/promises";

const REPO_OWNER = "zuohuadong";
const REPO_NAME = "supacloud";
// 采用内部代理或直连
const PROXY_PREFIX = "https://gh-proxy.net/";
const GITHUB_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

export async function runUpgrade() {
    console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║          SupaCloud CLI Updater                            ║
  ╚═══════════════════════════════════════════════════════════╝
  `);

    try {
        console.log(`\x1b[34m[STEP]\x1b[0m 正在检查最新版本信息...`);

        // 1. 获取最新 Release 信息
        const res = await fetch(GITHUB_API, {
            headers: {
                "User-Agent": "SupaCloud-CLI",
                "Accept": "application/vnd.github.v3+json"
            }
            // 此处可设较短 timeout，为简化略
        });

        if (!res.ok) {
            throw new Error(`无法连接到 GitHub API (Status: ${res.status})`);
        }

        const releaseData = await res.json();
        const latestVersion = releaseData.tag_name;
        const currentVersion = process.env.SUPACLOUD_VERSION || "v1.0.0"; // 如果有内置常量则可对比

        console.log(`\x1b[32m[INFO]\x1b[0m 发现版本: ${latestVersion}`);

        // 2. 匹配本机架构
        const arch = os.arch();
        let binArch = "amd64";
        if (arch === "arm64") {
            binArch = "arm64";
        }
        const targetAsset = `supacloud-api-linux-${binArch}`;

        // 查找对应资产
        const asset = releaseData.assets?.find((a: any) => a.name === targetAsset);
        if (!asset) {
            // 退回兼容命名尝试查找
            const fallbackAsset = releaseData.assets?.find((a: any) => a.name === "supacloud");
            if (!fallbackAsset) {
                throw new Error(`未在此 Release 中找到适配 ${arch} 架构的二进制文件(${targetAsset})`);
            }
        }

        // 使用兼容或找到的确切名字拼接下载地址
        const targetDownloadUrl = asset ? asset.browser_download_url : `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest/download/${targetAsset}`;

        console.log(`\x1b[34m[STEP]\x1b[0m 正在下载 ${targetAsset}... (将启用代理加速)`);

        // 当前二进制的绝对路径
        // Bun 中 process.execPath 指向当前可执行文件（如果是 bun build --compile 打包出来的，指向的就是自身）
        const currentExePath = process.execPath;
        const tempExePath = `${currentExePath}.new`;

        // 3. 开始下载并写入临时文件
        const downloadUrl = `${PROXY_PREFIX}${targetDownloadUrl}`;

        // 使用 Bun Shell 的灵活下载特性 
        const downloadRes = await $`curl -fsSL --progress-bar ${downloadUrl} -o ${tempExePath}`;

        if (downloadRes.exitCode !== 0) {
            console.log(`\x1b[33m[WARN]\x1b[0m 代理下载失败，正在尝试直连...`);
            const directRes = await $`curl -fsSL --progress-bar ${targetDownloadUrl} -o ${tempExePath}`;
            if (directRes.exitCode !== 0) {
                throw new Error("下载失败。请检查网络。");
            }
        }

        // 4. 重置权限并替换文件
        console.log(`\x1b[34m[STEP]\x1b[0m 设置执行权限并替换源程序...`);
        await chmod(tempExePath, 0o755);

        // Linux 允许对正在执行的文件执行 unlink 或 rename 至同名覆盖（某些文件系统需要 unlink 原文件）
        try {
            await rename(tempExePath, currentExePath);
        } catch (e: any) {
            // 如果遇到 Text File Busy，先 unlink
            if (e.code === 'ETXTBSY' || e.message.includes('busy')) {
                await unlink(currentExePath);
                await rename(tempExePath, currentExePath);
            } else {
                throw e;
            }
        }

        console.log(`
  ============================================================
  \x1b[32m升级成功！\x1b[0m 
  成功将 SupaCloud CLI 更新至 ${latestVersion}
  请重新运行您的命令。
  ============================================================
    `);

    } catch (error: any) {
        console.error(`\x1b[31m[ERROR]\x1b[0m 升级失败: ${error.message}`);
        process.exit(1);
    }
}
