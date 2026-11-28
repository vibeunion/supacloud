import type { ImgproxyConfig } from "./imgproxy/config";

const MAX_MEDIA_OUTPUT_BYTES = 64 * 1024 * 1024;

export class MediaDependencyError extends Error {
    readonly status = 422;

    constructor(message: string) {
        super(message);
        this.name = "MediaDependencyError";
    }
}

export type MediaKind = "pdf" | "video" | undefined;

export function detectMediaKind(
    bytes: Uint8Array,
    extension?: string,
    contentType?: string,
): MediaKind {
    const normalizedExtension = extension?.toLowerCase();
    if (normalizedExtension === "pdf" || contentType?.split(";")[0]?.trim().toLowerCase() === "application/pdf") {
        return "pdf";
    }
    if (contentType?.toLowerCase().startsWith("video/") || VIDEO_EXTENSIONS.has(normalizedExtension ?? "")) {
        return "video";
    }
    if (bytes.byteLength >= 5
        && bytes[0] === 0x25
        && bytes[1] === 0x50
        && bytes[2] === 0x44
        && bytes[3] === 0x46
        && bytes[4] === 0x2d) {
        return "pdf";
    }
    return undefined;
}

export async function renderPdfPage(
    input: Uint8Array,
    page: number,
    config: ImgproxyConfig,
): Promise<Uint8Array> {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    return runMediaCommand(
        config.pdfRendererPath,
        ["-png", "-singlefile", "-f", String(safePage), "-l", String(safePage), "-r", "150", "-", "-"],
        input,
        config.mediaProcessTimeoutMs,
        "PDF rendering requires pdftocairo",
    );
}

export async function renderVideoFrame(
    input: Uint8Array,
    second: number,
    config: ImgproxyConfig,
): Promise<Uint8Array> {
    const safeSecond = Number.isFinite(second) && second >= 0 ? second : 0;
    return runMediaCommand(
        config.ffmpegPath,
        [
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-ss",
            String(safeSecond),
            "-frames:v",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ],
        input,
        config.mediaProcessTimeoutMs,
        "Video thumbnails require ffmpeg",
    );
}

async function runMediaCommand(
    executable: string,
    args: string[],
    input: Uint8Array,
    timeoutMs: number,
    unavailableMessage: string,
): Promise<Uint8Array> {
    let process: ReturnType<typeof Bun.spawn>;
    try {
        process = Bun.spawn([executable, ...args], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });
    } catch {
        throw new MediaDependencyError(unavailableMessage);
    }

    const stdin = process.stdin;
    const stdout = process.stdout;
    const stderr = process.stderr;
    if (!stdin || typeof stdin === "number"
        || !stdout || typeof stdout === "number"
        || !stderr || typeof stderr === "number") {
        process.kill();
        throw new MediaDependencyError(unavailableMessage);
    }

    const timeout = setTimeout(() => process.kill(), Math.max(1_000, timeoutMs));
    try {
        stdin.write(input);
        stdin.end();
        const [exitCode, output, errorOutput] = await Promise.all([
            process.exited,
            new Response(stdout).arrayBuffer(),
            new Response(stderr).text().catch(() => ""),
        ]);
        if (exitCode !== 0) {
            const detail = errorOutput.trim().replace(/\s+/g, " ").slice(0, 240);
            throw new MediaDependencyError(detail || unavailableMessage);
        }
        const bytes = new Uint8Array(output);
        if (bytes.byteLength === 0) {
            throw new MediaDependencyError(unavailableMessage);
        }
        if (bytes.byteLength > MAX_MEDIA_OUTPUT_BYTES) {
            throw new MediaDependencyError("Rendered media output exceeds the image payload limit");
        }
        return bytes;
    } catch (error) {
        if (error instanceof MediaDependencyError) throw error;
        throw new MediaDependencyError(unavailableMessage);
    } finally {
        clearTimeout(timeout);
        try {
            stdin.end();
        } catch {
            // The child may have exited before stdin was closed.
        }
    }
}

const VIDEO_EXTENSIONS = new Set([
    "3gp",
    "avi",
    "flv",
    "m4v",
    "mkv",
    "mov",
    "mp4",
    "mpeg",
    "mpg",
    "ogv",
    "ts",
    "webm",
    "wmv",
]);
