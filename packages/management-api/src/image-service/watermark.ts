import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import type { WatermarkAnchor } from "./types";

let watermarkFontFamily = "sans-serif";

export function configureWatermarkFont(path?: string): void {
    const fontPath = path || process.env.IMAGE_WATERMARK_FONT_PATH;
    if (!fontPath) return;
    try {
        const key = GlobalFonts.registerFromPath(fontPath, "SupaCloudWatermark");
        if (key) watermarkFontFamily = "SupaCloudWatermark";
    } catch (error) {
        console.warn("[image-service] watermark font could not be registered:", error);
    }
}

export function renderTextWatermark(
    text: string,
    fontSize: number,
    color: string,
    opacity: number,
): Uint8Array {
    const measureCanvas = createCanvas(1, 1);
    const measureContext = measureCanvas.getContext("2d");
    const font = `${fontSize}px "${watermarkFontFamily}"`;
    measureContext.font = font;
    const metrics = measureContext.measureText(text);

    const width = Math.max(1, Math.ceil(metrics.width + fontSize * 0.5));
    const height = Math.max(1, Math.ceil(fontSize * 1.5));
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.font = font;
    context.fillStyle = color;
    context.globalAlpha = Math.min(1, Math.max(0, opacity));
    context.textBaseline = "middle";
    context.fillText(text, fontSize * 0.25, height / 2);

    return new Uint8Array(canvas.toBuffer("image/png"));
}

export function anchorOffset(anchor: WatermarkAnchor, area: number, content: number): number {
    if (anchor === "start") return 0;
    if (anchor === "center") return Math.max(0, Math.floor((area - content) / 2));
    if (anchor === "end") return Math.max(0, area - content);
    return Math.min(anchor, Math.max(0, area - content));
}
