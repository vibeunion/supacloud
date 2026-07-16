import { statSync } from "node:fs";
import path from "node:path";

export const WEB_CONSOLE_CURRENT_DIR = "/opt/supacloud/web-console/current";
export const WEB_CONSOLE_LEGACY_DIR = "/opt/supacloud/packages/web-console/build";

function hasIndexHtml(directory: string) {
    try {
        return statSync(path.join(directory, "index.html")).isFile();
    } catch {
        return false;
    }
}

type ResolveWebConsoleDirOptions = {
    env?: Record<string, string | undefined>;
    currentDir?: string;
    legacyDir?: string;
    hasIndexHtml?: (directory: string) => boolean;
};

export function resolveWebConsoleDir(options: ResolveWebConsoleDirOptions = {}): string {
    const {
        env = process.env,
        currentDir = WEB_CONSOLE_CURRENT_DIR,
        legacyDir = WEB_CONSOLE_LEGACY_DIR,
        hasIndexHtml: hasConfiguredIndexHtml = hasWebConsoleIndexHtml,
    } = options;

    const configuredDir = env.WEB_CONSOLE_DIR?.trim();
    if (configuredDir && hasConfiguredIndexHtml(configuredDir)) {
        return configuredDir;
    }

    if (hasConfiguredIndexHtml(currentDir)) {
        return currentDir;
    }

    return hasConfiguredIndexHtml(legacyDir) ? legacyDir : currentDir;
}

export function hasWebConsoleIndexHtml(directory: string) {
    return hasIndexHtml(directory);
}
