import {
    ChromaSubsampling,
    FastResizeFilter,
    ResizeFit,
    Transformer,
    pngQuantizeSync,
    type Metadata,
} from "@napi-rs/image";
import {
    applyFilters,
    applyMinimumDimensions,
    applyOrientation,
    applyPadding,
    applyWatermarks,
    clamp,
    cropTransformer,
    extendImage,
    flattenImage,
    formatSupportsAlpha,
    gravityRect,
    hasAlphaChannel,
    smartCropRect,
    trimImage,
    toRgba,
} from "./effects";
import { decodeGif, decodeGifFrames, encodeGif, encodeGifFrames } from "./gif";
import type {
    CropOptions,
    Gravity,
    ProcessedImage,
    TargetFormat,
    TransformOptions,
} from "./types";

export const MAX_IMAGE_WIDTH = 10000;
export const MAX_IMAGE_HEIGHT = 10000;
export const MAX_IMAGE_PIXELS = 50_000_000;
export const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

export class ImageEngineError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = "ImageEngineError";
    }
}

type ResizeResult = {
    transformer: Transformer;
    target: { width: number; height: number } | null;
    result: { width: number; height: number };
};

export type DecodedImage = {
    transformer: Transformer;
    metadata: Metadata;
    input: Uint8Array;
    format: string;
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeFormat(format: string): string {
    const value = format.toLowerCase();
    if (value === "jpg") return "jpeg";
    if (value === "tif") return "tiff";
    return value;
}

function looksLikeSvg(input: Uint8Array): boolean {
    const head = new TextDecoder().decode(input.slice(0, 1024)).toLowerCase();
    return head.includes("<svg") || (head.includes("<?xml") && head.includes("<svg"));
}

function injectSvgStyle(svg: string, css: string): string {
    const style = `<style>${css.replace(/<\/style/gi, "<\\/style")}</style>`;
    const open = svg.indexOf("<svg");
    if (open < 0) return svg;
    const tagEnd = svg.indexOf(">", open);
    if (tagEnd < 0) return svg;
    return `${svg.slice(0, tagEnd + 1)}${style}${svg.slice(tagEnd + 1)}`;
}

function parseSvgSize(svg: string): { width: number; height: number } | undefined {
    const widthMatch = svg.match(/\bwidth\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i);
    const heightMatch = svg.match(/\bheight\s*=\s*["']\s*([\d.]+)(?:px)?\s*["']/i);
    const viewBoxMatch = svg.match(/\bviewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
    const width = widthMatch ? Number.parseFloat(widthMatch[1]) : NaN;
    const height = heightMatch ? Number.parseFloat(heightMatch[1]) : NaN;
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return { width: Math.round(width), height: Math.round(height) };
    }
    if (viewBoxMatch) {
        const viewBoxWidth = Number.parseFloat(viewBoxMatch[1]);
        const viewBoxHeight = Number.parseFloat(viewBoxMatch[2]);
        if (viewBoxWidth > 0 && viewBoxHeight > 0) {
            return { width: Math.round(viewBoxWidth), height: Math.round(viewBoxHeight) };
        }
    }
    return undefined;
}

export function decodeImage(input: Uint8Array, svgStyle?: string, maxSourcePixels = 0): DecodedImage {
    if (input.byteLength === 0) {
        throw new ImageEngineError("Empty image payload", 400);
    }
    if (input.byteLength > MAX_PAYLOAD_BYTES) {
        throw new ImageEngineError(
            `Image exceeds maximum payload size of ${MAX_PAYLOAD_BYTES} bytes`,
            413,
        );
    }

    const svg = looksLikeSvg(input);
    let transformer: Transformer;
    try {
        if (svg) {
            const source = new TextDecoder().decode(input);
            transformer = Transformer.fromSvg(svgStyle ? injectSvgStyle(source, svgStyle) : source);
            const intrinsic = parseSvgSize(source);
            if (intrinsic) {
                const rendered = transformer.metadataSync();
                if (rendered.width !== intrinsic.width || rendered.height !== intrinsic.height) {
                    transformer.fastResize({
                        width: Math.min(intrinsic.width, MAX_IMAGE_WIDTH),
                        height: Math.min(intrinsic.height, MAX_IMAGE_HEIGHT),
                        fit: ResizeFit.Fill,
                    });
                }
            }
        } else if (isGif(input)) {
            transformer = decodeGif(input);
        } else {
            transformer = new Transformer(input);
        }
    } catch (error) {
        throw new ImageEngineError(`Failed to decode image: ${errorMessage(error)}`, 415);
    }

    const metadata = transformer.metadataSync();
    const pixelLimit = maxSourcePixels > 0
        ? Math.min(MAX_IMAGE_PIXELS, maxSourcePixels)
        : MAX_IMAGE_PIXELS;
    if (
        metadata.width > MAX_IMAGE_WIDTH
        || metadata.height > MAX_IMAGE_HEIGHT
        || metadata.width * metadata.height > pixelLimit
    ) {
        throw new ImageEngineError(
            `Image dimensions (${metadata.width}x${metadata.height}) exceed maximum allowed pixels (${pixelLimit})`,
            422,
        );
    }

    return {
        transformer,
        metadata,
        input,
        format: svg ? "svg" : isGif(input) ? "gif" : normalizeFormat(metadata.format),
    };
}

function isGif(input: Uint8Array): boolean {
    return input.byteLength > 6
        && input[0] === 0x47
        && input[1] === 0x49
        && input[2] === 0x46
        && input[3] === 0x38;
}

export function processImage(
    input: Uint8Array,
    options: TransformOptions,
    watermarkImage?: Uint8Array,
): ProcessedImage {
    if (isGif(input) && !options.disableAnimation && !options.isMeta) {
        return processAnimatedGif(input, options, watermarkImage);
    }
    const decoded = decodeImage(input, options.svgStyle, options.maxSourcePixels ?? 0);
    if (options.isMeta) {
        return {
            bytes: new TextEncoder().encode(JSON.stringify({
                format: decoded.format,
                width: decoded.metadata.width,
                height: decoded.metadata.height,
                orientation: decoded.metadata.orientation ?? 1,
                size_bytes: input.byteLength,
                has_alpha: hasAlphaChannel(decoded.metadata.colorType),
                ...(decoded.metadata.exif ? { exif: decoded.metadata.exif } : {}),
            }, null, 2)),
            contentType: "application/json",
        };
    }

    const transformer = applyMaxResultDimension(
        applyPipeline(decoded, options, watermarkImage),
        options.maxResultDimension,
    );
    return encodeImage(transformer, options, decoded);
}

function processAnimatedGif(
    input: Uint8Array,
    options: TransformOptions,
    watermarkImage?: Uint8Array,
): ProcessedImage {
    let frames: ReturnType<typeof decodeGifFrames>;
    try {
        frames = decodeGifFrames(
            input,
            options.maxAnimationFrames ?? 0,
            options.maxAnimationFrameResolution && options.maxAnimationFrameResolution > 0
                ? Math.round(options.maxAnimationFrameResolution * 1_000_000)
                : MAX_IMAGE_PIXELS,
        );
    } catch (error) {
        throw new ImageEngineError(`Failed to decode animated image: ${errorMessage(error)}`, 415);
    }
    if (frames.length === 0) {
        throw new ImageEngineError("Animated image contains no frames", 415);
    }

    const outputFormat = options.format ?? "gif";
    if (outputFormat !== "gif") {
        const first = Transformer.fromRgbaPixels(frames[0].data, frames[0].width, frames[0].height);
        const decoded: DecodedImage = {
            transformer: first,
            metadata: first.metadataSync(),
            input,
            format: "gif",
        };
        return encodeImage(
            applyMaxResultDimension(applyPipeline(decoded, options, watermarkImage), options.maxResultDimension),
            options,
            decoded,
        );
    }

    const outputFrames = frames.map((frame) => {
        const transformer = Transformer.fromRgbaPixels(frame.data, frame.width, frame.height);
        const decoded: DecodedImage = {
            transformer,
            metadata: transformer.metadataSync(),
            input,
            format: "gif",
        };
        const processed = applyMaxResultDimension(
            applyPipeline(decoded, { ...options, format: "png" }, watermarkImage),
            options.maxResultDimension,
        );
        const rgba = toRgba(processed);
        return {
            data: rgba.data,
            width: rgba.width,
            height: rgba.height,
            delayMs: frame.delayMs,
        };
    });
    return {
        bytes: encodeGifFrames(outputFrames),
        contentType: "image/gif",
    };
}

function applyMaxResultDimension(
    transformer: Transformer,
    maxDimension?: number,
): Transformer {
    if (!maxDimension || maxDimension <= 0) return transformer;
    const metadata = transformer.metadataSync();
    if (metadata.width <= maxDimension && metadata.height <= maxDimension) return transformer;
    const scale = maxDimension / Math.max(metadata.width, metadata.height);
    transformer.fastResize({
        width: Math.max(1, Math.round(metadata.width * scale)),
        height: Math.max(1, Math.round(metadata.height * scale)),
        fit: ResizeFit.Fill,
    });
    return transformer;
}

function applyPipeline(
    decoded: DecodedImage,
    options: TransformOptions,
    watermarkImage?: Uint8Array,
): Transformer {
    let transformer = decoded.transformer;

    if (options.autoRotate !== false) {
        try {
            transformer.rotate();
            decoded.metadata = transformer.metadataSync();
        } catch {
            // Some formats cannot be auto-rotated; keep the original pixels.
        }
    }

    if (options.trim) {
        transformer = trimImage(transformer, options.trim);
    }
    if (options.crop) {
        transformer = applyCrop(transformer, options.crop, options.gravity, options.cropAspectRatio);
    }

    const resized = applyResize(transformer, options);
    transformer = resized.transformer;

    if (options.extend || options.extendAspectRatio) {
        transformer = extendImage(transformer, options, resized.target);
    }
    if (options.minWidth !== undefined || options.minHeight !== undefined) {
        transformer = applyMinimumDimensions(transformer, options);
    }

    applyOrientation(transformer, options);
    applyFilters(transformer, options);

    if (options.padding) {
        transformer = applyPadding(transformer, options.padding, options.background);
    }

    applyWatermarks(transformer, options, watermarkImage);

    if (options.background && !formatSupportsAlpha(options.format)) {
        transformer = flattenImage(transformer, options.background);
    }

    return transformer;
}

function applyResize(transformer: Transformer, options: TransformOptions): ResizeResult {
    const metadata = transformer.metadataSync();
    const zoom = options.zoom ?? 1;
    const dpr = options.dpr ?? 1;
    let targetWidth = options.width ? Math.round(options.width * zoom * dpr) : 0;
    let targetHeight = options.height ? Math.round(options.height * zoom * dpr) : 0;

    if (targetWidth === 0 && targetHeight === 0) {
        return {
            transformer,
            target: null,
            result: { width: metadata.width, height: metadata.height },
        };
    }
    if (targetWidth === 0) {
        targetWidth = Math.max(1, Math.round((metadata.width * targetHeight) / metadata.height));
    }
    if (targetHeight === 0) {
        targetHeight = Math.max(1, Math.round((metadata.height * targetWidth) / metadata.width));
    }

    let type = options.resizeType;
    if (!type) {
        if (options.fitIn) type = "fit";
        else if (options.stretch) type = "force";
        else if (options.smart || options.gravity?.type === "sm") type = "smart";
        else type = "fill";
    }

    const smartGravity = options.gravity?.type === "sm"
        || options.gravity?.type === "obj"
        || options.gravity?.type === "objw";
    if (type === "smart" || smartGravity) {
        const rect = smartCropRect(
            new Uint8Array(transformer.pngSync()),
            metadata.width,
            metadata.height,
            targetWidth,
            targetHeight,
        );
        if (rect.width !== metadata.width || rect.height !== metadata.height) {
            transformer = cropTransformer(transformer, rect);
        }
    }

    const current = transformer.metadataSync();
    let actualType = type;
    if (type === "auto") {
        const sourceLandscape = current.width >= current.height;
        const targetLandscape = targetWidth >= targetHeight;
        actualType = sourceLandscape === targetLandscape ? "fill" : "fit";
    }
    if (type === "smart") actualType = "fill";

    let scale: number;
    if (actualType === "fit") {
        scale = Math.min(targetWidth / current.width, targetHeight / current.height);
    } else {
        scale = Math.max(targetWidth / current.width, targetHeight / current.height);
    }
    if (!options.enlarge && scale > 1) scale = 1;

    let resultWidth = Math.max(1, Math.round(current.width * scale));
    let resultHeight = Math.max(1, Math.round(current.height * scale));
    if (actualType === "force") {
        resultWidth = targetWidth;
        resultHeight = targetHeight;
    }

    if (resultWidth !== current.width || resultHeight !== current.height) {
        transformer.fastResize({
            width: resultWidth,
            height: resultHeight,
            filter: mapResizeFilter(options.resizeFilter),
            fit: ResizeFit.Fill,
        });
    }

    if (actualType === "fill" || actualType === "fill-down") {
        const cropWidth = Math.min(targetWidth, resultWidth);
        const cropHeight = Math.min(targetHeight, resultHeight);
        if (cropWidth !== resultWidth || cropHeight !== resultHeight) {
            const rect = gravityRect(
                resultWidth,
                resultHeight,
                cropWidth,
                cropHeight,
                options.gravity,
            );
            transformer = cropTransformer(transformer, rect);
        } else if (actualType === "fill-down" && resultWidth < targetWidth && resultHeight < targetHeight) {
            const aspect = targetWidth / targetHeight;
            let cropW = resultWidth;
            let cropH = Math.round(cropW / aspect);
            if (cropH > resultHeight) {
                cropH = resultHeight;
                cropW = Math.round(cropH * aspect);
            }
            if (cropW !== resultWidth || cropH !== resultHeight) {
                transformer = cropTransformer(
                    transformer,
                    gravityRect(resultWidth, resultHeight, cropW, cropH, options.gravity),
                );
            }
        }
    }

    return {
        transformer,
        target: { width: targetWidth, height: targetHeight },
        result: { width: resultWidth, height: resultHeight },
    };
}

function mapResizeFilter(filter?: TransformOptions["resizeFilter"]): FastResizeFilter {
    switch (filter) {
        case "nearest":
            return FastResizeFilter.Box;
        case "linear":
            return FastResizeFilter.Bilinear;
        case "cubic":
            return FastResizeFilter.CatmullRom;
        case "lanczos2":
        case "lanczos3":
        default:
            return FastResizeFilter.Lanczos3;
    }
}

function applyCrop(
    transformer: Transformer,
    crop: CropOptions,
    fallbackGravity?: Gravity,
    aspectRatio?: number,
): Transformer {
    const metadata = transformer.metadataSync();
    let width = dimensionValue(crop.width, metadata.width);
    let height = dimensionValue(crop.height, metadata.height);
    if (aspectRatio && aspectRatio > 0) {
        if (width / height > aspectRatio) {
            width = Math.max(1, Math.round(height * aspectRatio));
        } else {
            height = Math.max(1, Math.round(width / aspectRatio));
        }
    }
    const rect = gravityRect(metadata.width, metadata.height, width, height, crop.gravity ?? fallbackGravity);
    return cropTransformer(transformer, rect);
}

function dimensionValue(value: number, fullSize: number): number {
    if (value <= 0) return fullSize;
    if (value < 1) return Math.max(1, Math.round(fullSize * value));
    return Math.max(1, Math.min(fullSize, Math.round(value)));
}

export function encodeImage(
    transformer: Transformer,
    options: TransformOptions,
    decoded?: DecodedImage,
): ProcessedImage {
    const format = options.format ?? defaultOutputFormat(decoded?.format);
    const quality = clamp(Math.round(options.formatQuality?.[format] ?? options.quality), 1, 100);

    if (options.maxBytes || options.autoQuality?.method === "size") {
        const target = options.maxBytes ?? options.autoQuality?.target ?? 0;
        if (target > 0) {
            return encodeWithTargetBytes(transformer, options, format, quality, target);
        }
    }

    return encodeFormat(transformer, options, format, quality);
}

function defaultOutputFormat(source?: string): TargetFormat {
    switch (source) {
        case "jpeg":
        case "png":
        case "webp":
        case "avif":
        case "gif":
        case "bmp":
        case "tiff":
        case "ico":
            return source;
        default:
            return "webp";
    }
}

function encodeFormat(
    transformer: Transformer,
    options: TransformOptions,
    format: TargetFormat,
    quality: number,
): ProcessedImage {
    switch (format) {
        case "avif":
            return {
                bytes: new Uint8Array(transformer.avifSync({
                    quality,
                    speed: 6,
                    ...(options.avifOptions?.subsample?.includes("420")
                        ? { chromaSubsampling: ChromaSubsampling.Yuv420 }
                        : {}),
                })),
                contentType: "image/avif",
            };
        case "jpeg":
            return {
                bytes: new Uint8Array(flattenImage(transformer, options.background).jpegSync(quality)),
                contentType: "image/jpeg",
            };
        case "png": {
            const png = transformer.pngSync();
            let output = png;
            if (options.pngOptions?.quantize === true || options.pngOptions?.quantizationColors !== undefined) {
                try {
                    output = pngQuantizeSync(png, {
                        minQuality: Math.max(0, quality - 20),
                        maxQuality: quality,
                        speed: 5,
                        ...(options.pngOptions?.quantizationColors
                            ? { colors: clamp(options.pngOptions.quantizationColors, 2, 256) }
                            : {}),
                    });
                } catch {
                    // Tiny or unusual images can be rejected by the quantizer; keep the PNG.
                }
            }
            return { bytes: new Uint8Array(output), contentType: "image/png" };
        }
        case "gif":
            return {
                bytes: encodeGif(transformer),
                contentType: "image/gif",
            };
        case "bmp":
            return {
                bytes: new Uint8Array(flattenImage(transformer, options.background).bmpSync()),
                contentType: "image/bmp",
            };
        case "tiff":
            return {
                bytes: new Uint8Array(flattenImage(transformer, options.background).tiffSync()),
                contentType: "image/tiff",
            };
        case "ico":
            return {
                bytes: new Uint8Array(transformer.icoSync()),
                contentType: "image/x-icon",
            };
        case "webp":
        default:
            return {
                bytes: new Uint8Array(transformer.webpSync(quality)),
                contentType: "image/webp",
            };
    }
}

function encodeWithTargetBytes(
    transformer: Transformer,
    options: TransformOptions,
    format: TargetFormat,
    quality: number,
    targetBytes: number,
): ProcessedImage {
    let currentQuality = quality;
    let output = encodeFormat(transformer, options, format, currentQuality);
    while (output.bytes.byteLength > targetBytes && currentQuality > 10) {
        currentQuality = Math.max(10, currentQuality - 5);
        output = encodeFormat(transformer, options, format, currentQuality);
    }
    return output;
}
