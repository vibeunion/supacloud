import {
    ImageEngineError,
    MAX_PAYLOAD_BYTES,
    processImage,
} from "./engine";
import { parsePath } from "./parser";
import type { TargetFormat } from "./types";

export const ENGINE_NAME = "supacloud-image/napi-rs";
export const ENGINE_VERSION = "0.2.0";

function engineHeaders(): Headers {
    const headers = new Headers();
    headers.set("X-Image-Engine", ENGINE_NAME);
    return headers;
}

function negotiateFormat(accept: string | null): TargetFormat | undefined {
    if (!accept) return undefined;
    if (accept.includes("image/avif")) return "avif";
    if (accept.includes("image/webp")) return "webp";
    return undefined;
}

export function createImageServiceHandler(): (request: Request) => Promise<Response> {
    return async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        if (url.pathname === "/healthcheck" || url.pathname === "/health") {
            if (request.method !== "GET" && request.method !== "POST") {
                return new Response("Method not allowed", { status: 405, headers: engineHeaders() });
            }
            const headers = engineHeaders();
            headers.set("Content-Type", "application/json");
            return new Response(
                JSON.stringify({
                    status: "healthy",
                    engine: ENGINE_NAME,
                    version: ENGINE_VERSION,
                }),
                { status: 200, headers },
            );
        }

        if (request.method !== "POST") {
            return new Response(
                "POST request with raw image bytes required for transformations",
                { status: 405, headers: engineHeaders() },
            );
        }

        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > MAX_PAYLOAD_BYTES) {
            return new Response(
                `Image exceeds maximum payload size of ${MAX_PAYLOAD_BYTES} bytes`,
                { status: 413, headers: engineHeaders() },
            );
        }

        const options = parsePath(url.pathname);
        const negotiatedFormat = !options.format;
        if (!options.format) {
            options.format = negotiateFormat(request.headers.get("accept"));
        }

        let watermarkImage: Uint8Array | undefined;
        const watermarkHeader = request.headers.get("x-supacloud-watermark-image");
        if (watermarkHeader) {
            try {
                watermarkImage = new Uint8Array(Buffer.from(watermarkHeader, "base64"));
            } catch {
                return new Response("Invalid watermark image encoding", {
                    status: 400,
                    headers: engineHeaders(),
                });
            }
        }

        try {
            const result = processImage(body, options, watermarkImage);
            const headers = engineHeaders();
            headers.set("Content-Type", result.contentType);
            headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
            if (negotiatedFormat) headers.set("Vary", "Accept");
            return new Response(new Uint8Array(result.bytes).buffer, { status: 200, headers });
        } catch (error) {
            if (error instanceof ImageEngineError) {
                return new Response(error.message, { status: error.status, headers: engineHeaders() });
            }
            console.error("[image-service] processing error:", error);
            return new Response("Internal image processing error", {
                status: 500,
                headers: engineHeaders(),
            });
        }
    };
}
