import type { TargetFormat, TransformOptions, WatermarkAnchor } from "./types";

const TARGET_FORMATS: Record<string, TargetFormat> = {
    avif: "avif",
    webp: "webp",
    jpeg: "jpeg",
    jpg: "jpeg",
    png: "png",
    bmp: "bmp",
    tiff: "tiff",
    tif: "tiff",
};

const NAMED_COLORS: Record<string, string> = {
    white: "#ffffff",
    black: "#000000",
    red: "#ff0000",
    green: "#00ff00",
    blue: "#0000ff",
    transparent: "rgba(0,0,0,0)",
};

export function defaultTransformOptions(): TransformOptions {
    return {
        fitIn: false,
        stretch: false,
        smart: false,
        flipHorizontal: false,
        flipVertical: false,
        quality: 80,
        grayscale: false,
        invert: false,
        isMeta: false,
        watermarkX: "center",
        watermarkY: "end",
        watermarkOpacity: 0.3,
        watermarkColor: "#ffffff",
        watermarkFontSize: 14,
    };
}

export function parseWatermarkAnchor(
    value: string | undefined,
    fallback: WatermarkAnchor,
): WatermarkAnchor {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (!normalized) return fallback;
    if (["left", "top", "start", "north", "west"].includes(normalized)) return "start";
    if (["center", "middle"].includes(normalized)) return "center";
    if (["right", "bottom", "end", "south", "east"].includes(normalized)) return "end";
    const pixels = Number.parseInt(normalized, 10);
    return Number.isInteger(pixels) && pixels >= 0 ? pixels : fallback;
}

export function parseColor(value: string | undefined): string {
    const normalized = value?.trim().toLowerCase() ?? "";
    if (!normalized) return "#ffffff";
    if (NAMED_COLORS[normalized]) return NAMED_COLORS[normalized];
    const hex = normalized.startsWith("#") ? normalized.slice(1) : normalized;
    if (/^[0-9a-f]{6}$/.test(hex)) return `#${hex}`;
    if (/^[0-9a-f]{8}$/.test(hex)) {
        return `#${hex.slice(0, 6)}${hex.slice(6)}`;
    }
    return "#ffffff";
}

export function parsePath(path: string): TransformOptions {
    const options = defaultTransformOptions();
    const trimmed = path.replace(/^\/+|\/+$/g, "");
    if (!trimmed) return options;

    for (const segment of trimmed.split("/").filter(Boolean)) {
        if (segment === "meta" || segment === "info") {
            options.isMeta = true;
            continue;
        }
        if (["fit-in", "adaptive-fit-in", "full-fit-in", "adaptive-full-fit-in"].includes(segment)) {
            options.fitIn = true;
            continue;
        }
        if (segment === "stretch") {
            options.stretch = true;
            continue;
        }
        if (segment === "smart") {
            options.smart = true;
            continue;
        }
        if (segment.startsWith("filters:")) {
            parseFilters(segment.slice("filters:".length), options);
            continue;
        }

        const geometry = parseGeometry(segment);
        if (geometry) {
            options.width = geometry.width;
            options.height = geometry.height;
            options.flipHorizontal = geometry.flipHorizontal;
            options.flipVertical = geometry.flipVertical;
        }
    }

    return options;
}

function parseGeometry(segment: string): {
    width?: number;
    height?: number;
    flipHorizontal: boolean;
    flipVertical: boolean;
} | null {
    const separator = segment.indexOf("x");
    if (separator < 0) return null;

    const rawWidth = segment.slice(0, separator);
    const rawHeight = segment.slice(separator + 1);
    const flipHorizontal = rawWidth.startsWith("-");
    const flipVertical = rawHeight.startsWith("-");
    const width = parseDimension(flipHorizontal ? rawWidth.slice(1) : rawWidth);
    const height = parseDimension(flipVertical ? rawHeight.slice(1) : rawHeight);

    if (width === undefined && height === undefined) return null;
    return { width, height, flipHorizontal, flipVertical };
}

function parseDimension(value: string): number | undefined {
    if (!/^\d+$/.test(value)) return undefined;
    const parsed = Number.parseInt(value, 10);
    return parsed > 0 ? parsed : undefined;
}

function parseFilters(content: string, options: TransformOptions): void {
    for (const filter of splitTopLevel(content)) {
        const parsed = splitFilter(filter.trim());
        if (!parsed) continue;
        const { name, args } = parsed;

        switch (name) {
            case "format": {
                const format = TARGET_FORMATS[args.trim().toLowerCase()];
                if (format) options.format = format;
                break;
            }
            case "quality": {
                const quality = Number.parseInt(args.trim(), 10);
                if (Number.isInteger(quality)) options.quality = Math.min(100, Math.max(1, quality));
                break;
            }
            case "blur": {
                const sigma = Number.parseFloat(args.split(",")[0]?.trim() ?? "");
                if (Number.isFinite(sigma)) options.blurSigma = Math.max(0.1, sigma);
                break;
            }
            case "sharpen": {
                const sigma = Number.parseFloat(args.trim());
                if (Number.isFinite(sigma)) options.sharpenSigma = Math.max(0.1, sigma);
                break;
            }
            case "contrast": {
                const contrast = Number.parseFloat(args.trim());
                if (Number.isFinite(contrast)) options.contrast = contrast;
                break;
            }
            case "brightness": {
                const brightness = Number.parseInt(args.trim(), 10);
                if (Number.isInteger(brightness)) options.brightness = brightness;
                break;
            }
            case "grayscale":
                options.grayscale = true;
                break;
            case "invert":
                options.invert = true;
                break;
            case "rotate": {
                const degrees = Number.parseInt(args.trim(), 10);
                if (Number.isInteger(degrees)) options.rotateDeg = degrees;
                break;
            }
            case "text": {
                const parts = args.split(",");
                const encoded = parts[0]?.startsWith("b64:") ? parts[0].slice(4) : undefined;
                if (encoded) {
                    try {
                        options.watermarkText = Buffer.from(encoded, "base64url").toString("utf8");
                    } catch {
                        // Ignore malformed base64url text and keep the watermark empty.
                    }
                }
                options.watermarkX = parseWatermarkAnchor(parts[1], "center");
                options.watermarkY = parseWatermarkAnchor(parts[2], "end");
                if (parts[3] !== undefined) {
                    const sizeToken = parts[3].trim().split(/\s+/).pop();
                    const size = Number.parseInt(sizeToken ?? "", 10);
                    if (Number.isInteger(size)) options.watermarkFontSize = Math.min(200, Math.max(8, size));
                }
                if (parts[4] !== undefined) options.watermarkColor = parseColor(parts[4]);
                if (parts[5] !== undefined) {
                    const opacity = Number.parseFloat(parts[5]);
                    if (Number.isFinite(opacity)) {
                        options.watermarkOpacity = Math.min(1, Math.max(0, opacity / 100));
                    }
                }
                break;
            }
            case "watermark": {
                const parts = args.split(",");
                options.watermarkX = parseWatermarkAnchor(parts[1], "center");
                options.watermarkY = parseWatermarkAnchor(parts[2], "end");
                if (parts[3] !== undefined) {
                    const opacity = Number.parseFloat(parts[3]);
                    if (Number.isFinite(opacity)) {
                        options.watermarkOpacity = Math.min(1, Math.max(0, opacity / 100));
                    }
                }
                if (parts[4] !== undefined) {
                    const width = Number.parseInt(parts[4], 10);
                    if (Number.isInteger(width)) options.watermarkImageWidth = width;
                }
                if (parts[5] !== undefined) {
                    const height = Number.parseInt(parts[5], 10);
                    if (Number.isInteger(height)) options.watermarkImageHeight = height;
                }
                break;
            }
            default:
                break;
        }
    }
}

function splitTopLevel(content: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;

    for (let index = 0; index < content.length; index += 1) {
        const char = content[index];
        if (char === "(") depth += 1;
        if (char === ")") depth = Math.max(0, depth - 1);
        if (char === ":" && depth === 0) {
            parts.push(content.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(content.slice(start));
    return parts;
}

function splitFilter(filter: string): { name: string; args: string } | null {
    const open = filter.indexOf("(");
    const close = filter.lastIndexOf(")");
    if (open < 0 || close <= open) return null;
    return {
        name: filter.slice(0, open),
        args: percentDecode(filter.slice(open + 1, close)),
    };
}

function percentDecode(value: string): string {
    const bytes: number[] = [];
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] === "%" && index + 2 < value.length) {
            const byte = Number.parseInt(value.slice(index + 1, index + 3), 16);
            if (Number.isInteger(byte)) {
                bytes.push(byte);
                index += 2;
                continue;
            }
        }
        bytes.push(value.charCodeAt(index) & 0xff);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
}
