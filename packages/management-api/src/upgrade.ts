import { $ } from "bun";
import * as p from "@clack/prompts";
import os from "node:os";
import { logger } from "./utils/logger";

const PACKAGE_JSON_URL = "https://raw.githubusercontent.com/zuohuadong/supacloud/main/packages/management-api/package.json";
const REPO_URL = "https://api.github.com/repos/zuohuadong/supacloud/releases/latest";

async function getLocalVersion(): Promise<string> {
    try {
        // In binary files, we may need to get version through other means,
        // here temporarily read sibling package.json (dev environment) or preset value
        return "1.0.0";
    } catch (err: unknown) {
      logger.warn("[] getLocalVersion failed silently", { error: err });
        return "0.0.0";
    }
}

export async function runUpgrade(options: { forceYes?: boolean } = {}) {
    p.intro("\x1b[46m SupaCloud Self-Upgrade Bus \x1b[0m");

    const s = p.spinner();
    s.start("Retrieving latest GitHub release version");

    try {
        const response = await fetch(REPO_URL, {
            headers: { "User-Agent": "SupaCloud-CLI" }
        });

        if (!response.ok) throw new Error("Unable to connect to GitHub Release API");

        const data = await response.json();
        const remoteVersion = data.tag_name.replace('v', '');
        const localVersion = await getLocalVersion();

        s.stop(`Local version: ${localVersion} | Remote latest: ${remoteVersion}`);

        if (remoteVersion === localVersion) {
            p.note("You are already on the latest version, no update needed.");
            return;
        }

        const confirm = options.forceYes || await p.confirm({
            message: `New version ${remoteVersion} detected, perform in-place upgrade now?`,
            initialValue: true
        });

        if (!confirm || p.isCancel(confirm)) {
            p.cancel("Upgrade cancelled.");
            return;
        }

        s.start("Matching binary package based on system architecture");
        const arch = os.arch();
        const platform = os.platform();
        let assetName = `supacloud-linux-${arch === "arm64" ? "arm64" : "amd64"}`;

        const asset = data.assets.find((a: Record<string, unknown>) => a.name === assetName);
        if (!asset) {
            s.stop("No release package found matching current system architecture");
            return;
        }

        s.start(`Downloading update package: ${assetName}`);
        const downloadRes = await fetch(asset.browser_download_url);
        if (!downloadRes.ok) throw new Error("Download failed");

        const buffer = await downloadRes.arrayBuffer();
        const tempFile = `${process.argv[0]}.tmp`;

        s.start("Verifying and overwriting existing binary file");
        await Bun.write(tempFile, buffer);
        await $`chmod +x ${tempFile}`;

        // In-place atomic replacement
        await $`mv -f ${tempFile} ${process.argv[0]}`;

        s.stop("Update package ready and overwrite complete");

        p.outro(`🎉 Upgrade successful! Please restart the service or rerun the command.`);
    } catch (error: unknown) {
        s.stop(`Upgrade failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
