import { expect, test } from "bun:test";
import {
    detectMediaKind,
    renderPdfPage,
    renderVideoFrame,
} from "../../src/image-service/media";
import { getImgproxyConfig, resetImgproxyConfigCache } from "../../src/image-service/imgproxy/config";

test("detects PDF and video sources without misclassifying raster images", () => {
    expect(detectMediaKind(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("pdf");
    expect(detectMediaKind(new Uint8Array(), "mp4", "application/octet-stream")).toBe("video");
    expect(detectMediaKind(new Uint8Array(), undefined, "video/webm")).toBe("video");
    expect(detectMediaKind(new Uint8Array(), "png", "image/png")).toBeUndefined();
});

test("reports unavailable media helpers as 422", async () => {
    resetImgproxyConfigCache();
    process.env.IMGPROXY_FFMPEG_PATH = "/definitely/missing/ffmpeg";
    try {
        const config = getImgproxyConfig();
        await expect(renderVideoFrame(new Uint8Array([1, 2, 3]), 0, config))
            .rejects.toMatchObject({ status: 422 });
    } finally {
        delete process.env.IMGPROXY_FFMPEG_PATH;
        resetImgproxyConfigCache();
    }
});

test("renders a video frame when ffmpeg is installed", async () => {
    if (!Bun.which("ffmpeg")) return;
    resetImgproxyConfigCache();
    const config = getImgproxyConfig();
    const child = Bun.spawn([
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=16x16:d=1",
        "-f",
        "mp4",
        "-movflags",
        "frag_keyframe+empty_moov",
        "pipe:1",
    ], { stdout: "pipe", stderr: "pipe" });
    const input = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    expect(await child.exited).toBe(0);
    const output = await renderVideoFrame(input, 0, config);
    expect(output.slice(0, 8)).toEqual(new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
});

test("renders a PDF page when pdftocairo is installed", async () => {
    if (!Bun.which("pdftocairo") || !Bun.which("gs")) return;
    resetImgproxyConfigCache();
    const config = getImgproxyConfig();
    const child = Bun.spawn([
        "gs",
        "-q",
        "-sDEVICE=pdfwrite",
        "-o",
        "-",
        "-",
    ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write("%!PS-Adobe-3.0\n72 72 scale\n1 0 0 setrgbcolor\n0 0 1 1 rectfill\nshowpage\n");
    child.stdin.end();
    const input = new Uint8Array(await new Response(child.stdout).arrayBuffer());
    expect(await child.exited).toBe(0);
    const output = await renderPdfPage(input, 1, config);
    expect(output.slice(0, 8)).toEqual(new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]));
});

