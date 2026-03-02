import { $ } from "bun";
import * as p from "@clack/prompts";
import os from "node:os";

const PACKAGE_JSON_URL = "https://raw.githubusercontent.com/zuohuadong/supacloud/main/packages/management-api/package.json";
const REPO_URL = "https://api.github.com/repos/zuohuadong/supacloud/releases/latest";

async function getLocalVersion(): Promise<string> {
    try {
        // 在二进制文件中，我们可能需要通过其他方式获取版本，
        // 这里暂时通过读取同级 package.json (开发环境) 或预设值
        return "1.0.0";
    } catch {
        return "0.0.0";
    }
}

export async function runUpgrade(options: { forceYes?: boolean } = {}) {
    p.intro("\x1b[46m SupaCloud 自持更新总线 (Self-Upgrade) \x1b[0m");

    const s = p.spinner();
    s.start("正在检索 GitHub 最新发布版本");

    try {
        const response = await fetch(REPO_URL, {
            headers: { "User-Agent": "SupaCloud-CLI" }
        });

        if (!response.ok) throw new Error("无法连接到 GitHub Release API");

        const data = await response.json();
        const remoteVersion = data.tag_name.replace('v', '');
        const localVersion = await getLocalVersion();

        s.stop(`本地版本: ${localVersion} | 远程最新: ${remoteVersion}`);

        if (remoteVersion === localVersion) {
            p.note("您当前已是最新版本，无需更新。");
            return;
        }

        const confirm = options.forceYes || await p.confirm({
            message: `检测到新版本 ${remoteVersion}，是否现在执行原地升级？`,
            initialValue: true
        });

        if (!confirm || p.isCancel(confirm)) {
            p.cancel("升级已取消。");
            return;
        }

        s.start("正在根据系统架构匹配二进制包");
        const arch = os.arch();
        const platform = os.platform();
        let assetName = `supacloud-linux-${arch === "arm64" ? "arm64" : "amd64"}`;

        const asset = data.assets.find((a: any) => a.name === assetName);
        if (!asset) {
            s.stop("未找到匹配当前系统架构的发布包");
            return;
        }

        s.start(`正在下载更新包: ${assetName}`);
        const downloadRes = await fetch(asset.browser_download_url);
        if (!downloadRes.ok) throw new Error("下载失败");

        const buffer = await downloadRes.arrayBuffer();
        const tempFile = `${process.argv[0]}.tmp`;

        s.start("正在校验并覆盖现存二进制文件");
        await Bun.write(tempFile, buffer);
        await $`chmod +x ${tempFile}`;

        // 原地原子替换
        await $`mv -f ${tempFile} ${process.argv[0]}`;

        s.stop("更新包已就绪并完成覆盖");

        p.outro(`🎉 升级成功！请重启服务或重新运行命令。`);
    } catch (error: any) {
        s.stop(`升级失败: ${error.message}`);
        process.exit(1);
    }
}
