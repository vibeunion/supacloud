import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve the installed package's declared bin, not an internal file suffix. */
export function resolveLiteCommand(workdir: string, environment: NodeJS.ProcessEnv = process.env): string[] {
    const explicitBinary = environment.SUPACLOUD_LITE_CLI_BIN?.trim();
    if (explicitBinary) {
        if (explicitBinary.includes("\0")) throw new Error("Invalid SUPACLOUD_LITE_CLI_BIN");
        return [explicitBinary];
    }
    const packageRoot = join(resolve(workdir), "node_modules", "@supacloud", "lite");
    const manifestPath = join(packageRoot, "package.json");
    if (!existsSync(manifestPath)) return ["supacloud-lite"];
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!isRecord(manifest) || manifest.name !== "@supacloud/lite" || !isRecord(manifest.bin)) {
        throw new Error("Invalid installed @supacloud/lite package manifest");
    }
    const entry = manifest.bin["supacloud-lite"];
    if (typeof entry !== "string" || !entry.trim() || entry.includes("\0") || isAbsolute(entry)) {
        throw new Error("Invalid installed @supacloud/lite bin");
    }
    const executable = resolve(packageRoot, entry);
    const packageRelative = relative(packageRoot, executable);
    if (!packageRelative || packageRelative === ".." || packageRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(packageRelative)) {
        throw new Error("Installed @supacloud/lite bin must stay inside its package");
    }
    if (!existsSync(executable) || !statSync(executable).isFile()) {
        throw new Error("Installed @supacloud/lite bin is missing; reinstall the package");
    }
    return [process.execPath, executable];
}
