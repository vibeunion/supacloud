import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transformer } from "@napi-rs/image";
import { processImage } from "../../src/image-service/engine";
import { decodeGifFrames, encodeGif, encodeGifFrames } from "../../src/image-service/gif";
import {
    getImgproxyConfig,
    resetImgproxyConfigCache,
} from "../../src/image-service/imgproxy/config";
import { handleImgproxyRequest } from "../../src/image-service/imgproxy/handler";
import {
    parseInfoOptions,
    parseProcessingOptions,
} from "../../src/image-service/imgproxy/options";
import { signPath } from "../../src/image-service/imgproxy/signature";
import { parseImgproxyPath } from "../../src/image-service/imgproxy/url";
import { parsePath } from "../../src/image-service/parser";

const TEST_KEY = "736563726574";
const TEST_SALT = "68656C6C6F";
const keyBytes = Buffer.from(TEST_KEY, "hex");
const saltBytes = Buffer.from(TEST_SALT, "hex");
const originalEnv = { ...process.env };

function configure(overrides: Record<string, string | undefined> = {}): void {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("IMGPROXY_")) delete process.env[key];
    }
    for (const [key, value] of Object.entries(overrides)) {
        if (value !== undefined) process.env[key] = value;
    }
    resetImgproxyConfigCache();
}

afterAll(() => {
    for (const key of Object.keys(process.env)) {
        if (key.startsWith("IMGPROXY_")) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
        if (key.startsWith("IMGPROXY_") && value !== undefined) process.env[key] = value;
    }
    resetImgproxyConfigCache();
});

function signed(path: string, info = false): string {
    const signature = signPath(path, keyBytes, saltBytes);
    return info ? `/info/${signature}${path}` : `/${signature}${path}`;
}

function call(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(`http://image.local${path}`);
    return handleImgproxyRequest(new Request(url, init), url);
}

function gradient(width: number, height: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            data[index] = Math.round((x / Math.max(1, width - 1)) * 255);
            data[index + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
            data[index + 2] = Math.round(((x + y) / Math.max(1, width + height - 2)) * 255);
            data[index + 3] = 255;
        }
    }
    return data;
}

function makePng(width: number, height: number): Buffer {
    return Transformer.fromRgbaPixels(gradient(width, height), width, height).pngSync();
}

function base64Source(bytes: Uint8Array, mime: string, extension: string): string {
    const url = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    return `${Buffer.from(url).toString("base64url")}.${extension}`;
}

describe("imgproxy URL compatibility", () => {
    test("matches the documented signature vector", () => {
        const path = "/rs:fill:300:400:0/g:sm/aHR0cDovL2V4YW1w/bGUuY29tL2ltYWdl/cy9jdXJpb3NpdHku/anBn.png";
        expect(signPath(path, keyBytes, saltBytes)).toBe(
            "oKfUtW34Dvo2BGQehJFR4Nr0_rIjOtdtzJ3QFsUcXH8",
        );
    });

    test("parses base64, plain and info URLs", () => {
        const source = Buffer.from("http://example.com/image.jpg").toString("base64url");
        const parsed = parseImgproxyPath(`/signature/rs:fit:100:100/${source}.png`);
        expect(parsed.info).toBe(false);
        expect(parsed.options).toEqual(["rs:fit:100:100"]);
        expect(parsed.source.kind).toBe("base64");
        expect(parsed.source.extension).toBe("png");
        expect(Buffer.from(parsed.source.value, "base64url").toString("utf8"))
            .toBe("http://example.com/image.jpg");

        const plain = parseImgproxyPath("/signature/plain/http://example.com/image.jpg@png");
        expect(plain.source.kind).toBe("plain");
        expect(plain.source.value).toBe("http://example.com/image.jpg");
        expect(plain.source.extension).toBe("png");

        const info = parseImgproxyPath(`/info/signature/rs:fit:10:10/${source}`);
        expect(info.info).toBe(true);
        expect(info.signedPath).toBe(`/rs:fit:10:10/${source}`);
    });

    test("maps processing options", () => {
        configure();
        const request = parseProcessingOptions(
            [
                "rs:fill:300:400:1:1",
                "g:fp:0.25:0.75",
                "c:100:100:ce",
                "pd:10:20:30:40",
                "bg:255:0:0",
                "dt:0.5:black:white",
                "aq:size:50000:20:80",
                "mb:60000",
                "fq:jpeg=75:webp=80",
                "pbl:2:0:0.2:0.8",
                "wm:0.5:ce:10:20:0.3",
                "wmt:QUNNRQ:sans:24:red",
                "skp:png:webp",
                "exp:123",
                "fn:aGVsbG8:1",
                "hs:sha256:abc",
            ],
            { kind: "base64", value: "aHR0cDovL2V4YW1wbGUuY29tL2ltYWdlLmpwZw", extension: "jpg" },
            getImgproxyConfig(),
        );

        expect(request.transform.resizeType).toBe("fill");
        expect(request.transform.width).toBe(300);
        expect(request.transform.height).toBe(400);
        expect(request.transform.enlarge).toBe(true);
        expect(request.transform.extend).toBe(true);
        expect(request.transform.gravity).toEqual({ type: "fp", x: 0.25, y: 0.75 });
        expect(request.transform.crop).toEqual({
            width: 100,
            height: 100,
            gravity: { type: "ce", x: 0, y: 0 },
        });
        expect(request.transform.padding).toEqual({ top: 10, right: 20, bottom: 30, left: 40 });
        expect(request.transform.background).toBe("#ff0000");
        expect(request.transform.duotone).toEqual({ intensity: 0.5, dark: "black", light: "white" });
        expect(request.transform.autoQuality).toEqual({
            method: "size",
            target: 50000,
            min: 20,
            max: 80,
            allowedError: 0.001,
        });
        expect(request.transform.maxBytes).toBe(60000);
        expect(request.transform.formatQuality).toEqual({ jpeg: 75, webp: 80 });
        expect(request.transform.progressiveBlur).toEqual({
            sigma: 2,
            direction: 0,
            start: 0.2,
            stop: 0.8,
        });
        expect(request.transform.watermarkOpacity).toBe(0.5);
        expect(request.transform.watermarkPosition).toBe("ce");
        expect(request.transform.watermarkOffsetX).toBe(10);
        expect(request.transform.watermarkOffsetY).toBe(20);
        expect(request.transform.watermarkScale).toBe(0.3);
        expect(request.transform.watermarkText).toBe("ACME");
        expect(request.transform.watermarkFontSize).toBe(24);
        expect(request.transform.watermarkColor).toBe("red");
        expect(request.skipProcessing).toEqual(["png", "webp"]);
        expect(request.expires).toBe(123);
        expect(request.filename).toBe("hello");
        expect(request.hashsum).toEqual({ type: "sha256", hash: "abc" });
    });

    test("maps info options", () => {
        configure();
        const options = parseInfoOptions(
            ["size:0", "format:1", "dimensions:1", "exif:0", "dominant_colors:1", "colorspace:1"],
            getImgproxyConfig(),
        );
        expect(options.size).toBe(false);
        expect(options.format).toBe(true);
        expect(options.dimensions).toBe(true);
        expect(options.exif).toBe(false);
        expect(options.dominantColors).toBe(true);
        expect(options.colorspace).toBe(true);
    });
});

describe("imgproxy request handling", () => {
    test("processes a signed data URL", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const source = base64Source(makePng(40, 30), "image/png", "png");
        const response = await call(signed(`/rs:fit:20:20/${source}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        const metadata = new Transformer(new Uint8Array(await response.arrayBuffer())).metadataSync();
        expect(metadata.width).toBe(20);
        expect(metadata.height).toBe(15);
    });

    test("rejects an unsigned request", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const response = await call(`/invalid/${base64Source(makePng(10, 10), "image/png", "png")}`);
        expect(response.status).toBe(403);
    });

    test("returns imgproxy info JSON", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const source = base64Source(makePng(12, 8), "image/png", "png");
        const response = await call(signed(`/${source}`, true));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("application/json");
        const info = (await response.json()) as Record<string, unknown>;
        expect(info.format).toBe("png");
        expect(info.width).toBe(12);
        expect(info.height).toBe(8);
        expect(info.orientation).toBe(1);
    });

    test("returns raw source bytes", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const png = makePng(10, 10);
        const response = await call(signed(`/raw:1/${base64Source(png, "image/png", "png")}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
    });

    test("skips processing for matching formats", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const png = makePng(10, 10);
        const response = await call(signed(`/skp:png/${base64Source(png, "image/png", "png")}`));
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
    });

    test("returns 404 for expired URLs", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const source = base64Source(makePng(10, 10), "image/png", "png");
        const response = await call(signed(`/exp:1/${source}`));
        expect(response.status).toBe(404);
    });

    test("rejects unknown options", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const source = base64Source(makePng(10, 10), "image/png", "png");
        const response = await call(signed(`/not_an_option:1/${source}`));
        expect(response.status).toBe(400);
    });

    test("reports unsupported Pro video options as 422", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const source = base64Source(makePng(10, 10), "image/png", "png");
        const response = await call(signed(`/vtt:1/${source}`));
        expect(response.status).toBe(422);
    });

    test("reports unsupported Pro info options as 422", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const source = base64Source(makePng(10, 10), "image/png", "png");
        const response = await call(signed(`/detect_objects:1/${source}`, true));
        expect(response.status).toBe(422);
    });

    test("answers CORS preflight before bearer auth", async () => {
        configure({
            IMGPROXY_KEY: TEST_KEY,
            IMGPROXY_SALT: TEST_SALT,
            IMGPROXY_SECRET: "secret",
            IMGPROXY_ALLOW_ORIGIN: "*",
        });
        const preflight = await call("/rs:fit:1:1/plain/http://example.com/a.png", {
            method: "OPTIONS",
            headers: { Origin: "https://example.com" },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

        const unauthorized = await call(signed(`/rs:fit:1:1/${base64Source(makePng(4, 4), "image/png", "png")}`));
        expect(unauthorized.status).toBe(401);

        const authorized = await call(
            signed(`/rs:fit:2:2/${base64Source(makePng(4, 4), "image/png", "png")}`),
            { headers: { Authorization: "Bearer secret" } },
        );
        expect(authorized.status).toBe(200);
    });

    test("reads local sources and verifies hashsums", async () => {
        const root = mkdtempSync(join(tmpdir(), "supacloud-imgproxy-"));
        const png = makePng(10, 10);
        writeFileSync(join(root, "test.png"), png);
        configure({
            IMGPROXY_KEY: TEST_KEY,
            IMGPROXY_SALT: TEST_SALT,
            IMGPROXY_LOCAL_FILESYSTEM_ROOT: root,
        });
        try {
            const digest = createHash("sha256").update(png).digest("hex");
            const response = await call(signed(`/rs:fit:5:5/hs:sha256:${digest}/plain/local://test.png`));
            expect(response.status).toBe(200);
            const bad = await call(signed(`/rs:fit:5:5/hs:sha256:${"0".repeat(64)}/plain/local://test.png`));
            expect(bad.status).toBe(422);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("serves a cached result with ETag and conditional 304", async () => {
        const cacheDir = mkdtempSync(join(tmpdir(), "supacloud-imgproxy-cache-"));
        configure({
            IMGPROXY_KEY: TEST_KEY,
            IMGPROXY_SALT: TEST_SALT,
            IMGPROXY_RESULT_CACHE_DIR: cacheDir,
            IMGPROXY_RESULT_CACHE_TTL: "3600",
        });
        try {
            const source = base64Source(makePng(12, 8), "image/png", "png");
            const path = signed(`/rs:fit:6:6/fn:download.png/${source}`);
            const first = await call(path);
            expect(first.status).toBe(200);
            const etag = first.headers.get("etag");
            expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
            expect(first.headers.get("content-disposition")).toContain("download.png");

            const second = await call(path, { headers: { "If-None-Match": etag ?? "" } });
            expect(second.status).toBe(304);
            expect(second.headers.get("etag")).toBe(etag);
            expect(second.headers.get("content-disposition")).toContain("download.png");
        } finally {
            rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test("continues serving when the result cache is unavailable", async () => {
        const cachePath = join(mkdtempSync(join(tmpdir(), "supacloud-imgproxy-cache-file-")), "cache");
        writeFileSync(cachePath, "not a directory");
        configure({
            IMGPROXY_KEY: TEST_KEY,
            IMGPROXY_SALT: TEST_SALT,
            IMGPROXY_RESULT_CACHE_DIR: cachePath,
            IMGPROXY_RESULT_CACHE_TTL: "3600",
        });
        const source = base64Source(makePng(8, 8), "image/png", "png");
        const response = await call(signed(`/rs:fit:4:4/${source}`));
        expect(response.status).toBe(200);
    });

    test("loads native cloud object sources", async () => {
        const png = makePng(8, 8);
        const previousFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            expect(String(input)).toBe("https://s3.example.test/assets/test.png");
            return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        }) as typeof fetch;
        configure({
            IMGPROXY_KEY: TEST_KEY,
            IMGPROXY_SALT: TEST_SALT,
            IMGPROXY_S3_ENDPOINT: "https://s3.example.test",
        });
        try {
            const response = await call(signed(`/rs:fit:4:4/plain/s3://assets/test.png`));
            expect(response.status).toBe(200);
            expect(response.headers.get("content-type")).toBe("image/png");
            const metadata = new Transformer(new Uint8Array(await response.arrayBuffer())).metadataSync();
            expect(metadata.width).toBe(4);
            expect(metadata.height).toBe(4);
        } finally {
            globalThis.fetch = previousFetch;
        }
    });

    test("loads GCS, Azure Blob, and Swift object sources", async () => {
        const png = makePng(8, 8);
        const previousFetch = globalThis.fetch;
        const requests: Array<{ url: string; token?: string }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({
                url: String(input),
                token: new Headers(init?.headers).get("authorization")
                    ?? new Headers(init?.headers).get("x-auth-token")
                    ?? undefined,
            });
            return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
        }) as typeof fetch;
        try {
            configure({
                IMGPROXY_KEY: TEST_KEY,
                IMGPROXY_SALT: TEST_SALT,
                IMGPROXY_GCS_ENDPOINT: "https://gcs.example.test",
                IMGPROXY_GCS_TOKEN: "gcs-token",
                IMGPROXY_AZURE_ENDPOINT: "https://azure.example.test",
                IMGPROXY_AZURE_SAS: "sig=azure",
                IMGPROXY_SWIFT_ENDPOINT: "https://swift.example.test/v1/account",
                IMGPROXY_SWIFT_TOKEN: "swift-token",
            });
            for (const source of [
                "gs://bucket/path/to/image.png",
                "az://container/path/to/image.png",
                "swift://container/path/to/image.png",
            ]) {
                const response = await call(signed(`/rs:fit:4:4/plain/${source}`));
                expect(response.status).toBe(200);
            }
            expect(requests).toEqual([
                { url: "https://gcs.example.test/bucket/path/to/image.png", token: "Bearer gcs-token" },
                { url: "https://azure.example.test/container/path/to/image.png?sig=azure" },
                { url: "https://swift.example.test/v1/account/container/path/to/image.png", token: "swift-token" },
            ]);
        } finally {
            globalThis.fetch = previousFetch;
        }
    });

    test("decodes GIF and encodes GIF output", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const gif = encodeGif(Transformer.fromRgbaPixels(gradient(8, 8), 8, 8));
        const pngResponse = await call(signed(`/rs:fit:4:4/f:png/${base64Source(gif, "image/gif", "gif")}`));
        expect(pngResponse.status).toBe(200);
        expect(pngResponse.headers.get("content-type")).toBe("image/png");

        const gifResponse = await call(signed(`/f:gif/${base64Source(makePng(8, 8), "image/png", "png")}`));
        expect(gifResponse.status).toBe(200);
        expect(gifResponse.headers.get("content-type")).toBe("image/gif");
        const bytes = new Uint8Array(await gifResponse.arrayBuffer());
        expect(String.fromCharCode(...bytes.slice(0, 3))).toBe("GIF");
    });

    test("preserves animated GIF frames, delays, and transforms", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const frames = [
            { data: gradient(8, 8), width: 8, height: 8, delayMs: 80 },
            { data: gradient(8, 8).map((value, index) => index % 4 === 0 ? 255 - value : value), width: 8, height: 8, delayMs: 160 },
        ];
        const gif = encodeGifFrames(frames);
        const response = await call(signed(`/rs:fit:4:4/f:gif/${base64Source(gif, "image/gif", "gif")}`));
        expect(response.status).toBe(200);
        const output = new Uint8Array(await response.arrayBuffer());
        const decoded = decodeGifFrames(output);
        expect(decoded).toHaveLength(2);
        expect(decoded[0]?.delayMs).toBeGreaterThanOrEqual(80);
        expect(decoded[1]?.delayMs).toBeGreaterThanOrEqual(160);
        expect(decoded[0]?.width).toBe(4);
        expect(decoded[0]?.height).toBe(4);
    });

    test("rasterizes SVG sources", async () => {
        configure({ IMGPROXY_KEY: TEST_KEY, IMGPROXY_SALT: TEST_SALT });
        const svg = Buffer.from(
            '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="#ff0000"/></svg>',
        );
        const response = await call(
            signed(`/rs:fit:10:5/f:png/${base64Source(svg, "image/svg+xml", "svg")}`),
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("image/png");
        const metadata = new Transformer(new Uint8Array(await response.arrayBuffer())).metadataSync();
        expect(metadata.width).toBe(10);
        expect(metadata.height).toBe(5);
    });
});

describe("imgproxy engine extensions", () => {
    test("applies max_result_dimension", () => {
        const png = makePng(200, 120);
        const options = parsePath("/fit-in/200x200/filters:format(png)/");
        options.maxResultDimension = 100;
        const output = processImage(new Uint8Array(png), options);
        const metadata = new Transformer(output.bytes).metadataSync();
        expect(metadata.width).toBe(100);
        expect(metadata.height).toBe(60);
    });

    test("format_quality overrides the base quality", () => {
        const jpeg = Transformer.fromRgbaPixels(gradient(80, 80), 80, 80).jpegSync(95);
        const options = parsePath("/fit-in/80x80/filters:format(jpeg):quality(95)/");
        options.formatQuality = { jpeg: 20 };
        const output = processImage(new Uint8Array(jpeg), options);
        const lowQuality = processImage(
            new Uint8Array(jpeg),
            parsePath("/fit-in/80x80/filters:format(jpeg):quality(20)/"),
        );
        expect(Buffer.from(output.bytes).equals(Buffer.from(lowQuality.bytes))).toBe(true);
    });

    test("does not quantize PNG by default", () => {
        const png = makePng(40, 40);
        const output = processImage(
            new Uint8Array(png),
            parsePath("/fit-in/40x40/filters:format(png):quality(80)/"),
        );
        expect(Buffer.from(output.bytes).includes("PLTE")).toBe(false);
    });
});
