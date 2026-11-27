import { decodeImage } from "../engine";
import { toRgba } from "../effects";
import type { InfoOptions } from "./options";

const MIME_TYPES: Record<string, string> = {
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    avif: "image/avif",
    gif: "image/gif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    jxl: "image/jxl",
    heic: "image/heic",
};

export function buildInfoJson(
    bytes: Uint8Array,
    size: number | undefined,
    options: InfoOptions,
    maxSourcePixels = 0,
): string {
    const decoded = decodeImage(bytes, undefined, maxSourcePixels);
    const result: Record<string, unknown> = {};

    if (options.size) {
        result.size = size ?? bytes.byteLength;
    }
    if (options.format) {
        result.format = decoded.format;
        result.mime_type = MIME_TYPES[decoded.format] ?? `image/${decoded.format}`;
    }
    if (options.dimensions) {
        result.width = decoded.metadata.width;
        result.height = decoded.metadata.height;
        result.orientation = decoded.metadata.orientation ?? 1;
    }
    if (options.exif) {
        result.exif = decoded.metadata.exif ?? {};
    }
    if (options.colorspace) {
        result.colorspace = "srgb";
    }
    if (options.dominantColors) {
        result.dominant_colors = dominantColors(decoded.transformer);
    }

    return JSON.stringify(result, null, 2);
}

function dominantColors(transformer: ReturnType<typeof decodeImage>["transformer"]): Record<string, string> {
    const image = toRgba(transformer);
    const counts = new Map<number, number>();
    for (let index = 0; index < image.data.length; index += 4) {
        const r = image.data[index] >> 4;
        const g = image.data[index + 1] >> 4;
        const b = image.data[index + 2] >> 4;
        const key = (r << 8) | (g << 4) | b;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = [...counts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 16)
        .map(([key]) => {
            const r = ((key >> 8) & 15) * 17;
            const g = ((key >> 4) & 15) * 17;
            const b = (key & 15) * 17;
            const max = Math.max(r, g, b) / 255;
            const min = Math.min(r, g, b) / 255;
            const lightness = (max + min) / 2;
            const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
            return {
                hex: `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
                saturation,
                lightness,
            };
        });

    const pick = (predicate: (color: typeof sorted[number]) => boolean): string | undefined =>
        sorted.find(predicate)?.hex;
    const vibrant = pick((color) => color.saturation > 0.35 && color.lightness > 0.25 && color.lightness < 0.75);
    const lightVibrant = pick((color) => color.saturation > 0.3 && color.lightness >= 0.7);
    const darkVibrant = pick((color) => color.saturation > 0.3 && color.lightness <= 0.3);
    const muted = pick((color) => color.saturation <= 0.35 && color.lightness > 0.25 && color.lightness < 0.8);
    const lightMuted = pick((color) => color.saturation <= 0.35 && color.lightness >= 0.75);
    const darkMuted = pick((color) => color.saturation <= 0.35 && color.lightness <= 0.3);

    return {
        vibrant: vibrant ?? sorted[0]?.hex ?? "#000000",
        light_vibrant: lightVibrant ?? vibrant ?? sorted[0]?.hex ?? "#ffffff",
        dark_vibrant: darkVibrant ?? vibrant ?? sorted[0]?.hex ?? "#000000",
        muted: muted ?? sorted[0]?.hex ?? "#808080",
        light_muted: lightMuted ?? muted ?? "#ffffff",
        dark_muted: darkMuted ?? muted ?? "#000000",
    };
}
