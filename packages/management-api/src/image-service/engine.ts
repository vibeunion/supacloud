import {
    BlendMode,
    FastResizeFilter,
    JsColorType,
    Orientation,
    ResizeFit,
    Transformer,
    pngQuantizeSync,
    type Metadata,
} from "@napi-rs/image";
import { anchorOffset, renderTextWatermark } from "./watermark";
import type { ProcessedImage, TransformOptions } from "./types";

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

type CropRect = { x: number; y: number; width: number; height: number };

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hasAlphaChannel(colorType: JsColorType): boolean {
    return [
        JsColorType.La8,
        JsColorType.Rgba8,
        JsColorType.La16,
        JsColorType.Rgba16,
        JsColorType.Rgba32F,
    ].includes(colorType);
}

export function processImage(
    input: Uint8Array,
    options: TransformOptions,
    watermarkImage?: Uint8Array,
): ProcessedImage {
    if (input.byteLength === 0) {
        throw new ImageEngineError("Empty image payload", 400);
    }
    if (input.byteLength > MAX_PAYLOAD_BYTES) {
        throw new ImageEngineError(`Image exceeds maximum payload size of ${MAX_PAYLOAD_BYTES} bytes`, 413);
    }

    let transformer: Transformer;
    let metadata: Metadata;
    try {
        transformer = new Transformer(input);
        metadata = transformer.metadataSync();
    } catch (error) {
        throw new ImageEngineError(`Failed to decode image: ${errorMessage(error)}`, 415);
    }

    if (
        metadata.width > MAX_IMAGE_WIDTH
        || metadata.height > MAX_IMAGE_HEIGHT
        || metadata.width * metadata.height > MAX_IMAGE_PIXELS
    ) {
        throw new ImageEngineError(
            `Image dimensions (${metadata.width}x${metadata.height}) exceed maximum allowed pixels (${MAX_IMAGE_PIXELS})`,
            422,
        );
    }

    if (options.isMeta) {
        const payload = JSON.stringify({
            format: metadata.format.toLowerCase(),
            width: metadata.width,
            height: metadata.height,
            size_bytes: input.byteLength,
            has_alpha: hasAlphaChannel(metadata.colorType),
        }, null, 2);
        return {
            bytes: new TextEncoder().encode(payload),
            contentType: "application/json",
        };
    }

    const target = calculateTargetDimensions(metadata.width, metadata.height, options);
    if (target) {
        if (
            !options.fitIn
            && !options.stretch
            && options.width !== undefined
            && options.height !== undefined
        ) {
            if (options.smart) {
                const rect = smartCropRect(
                    input,
                    metadata.width,
                    metadata.height,
                    target.width,
                    target.height,
                );
                transformer.crop(rect.x, rect.y, rect.width, rect.height);
                // napi-rs/image 1.16 subtracts the crop's y offset from the next
                // resize's target height. Rebuilding the cropped pixels resets it.
                transformer = rebuildCroppedTransformer(transformer);
                transformer.fastResize({
                    width: target.width,
                    height: target.height,
                    filter: FastResizeFilter.Lanczos3,
                    fit: ResizeFit.Fill,
                });
            } else {
                transformer.fastResize({
                    width: target.width,
                    height: target.height,
                    filter: FastResizeFilter.Lanczos3,
                    fit: ResizeFit.Cover,
                });
            }
        } else {
            transformer.fastResize({
                width: target.width,
                height: target.height,
                filter: FastResizeFilter.Lanczos3,
                fit: ResizeFit.Fill,
            });
        }
    }

    applyFilters(transformer, options);
    applyWatermarks(transformer, options, watermarkImage);

    return encodeImage(transformer, options);
}

function calculateTargetDimensions(
    originalWidth: number,
    originalHeight: number,
    options: TransformOptions,
): { width: number; height: number } | null {
    if (options.width !== undefined && options.height !== undefined) {
        if (options.fitIn) {
            const ratio = Math.min(options.width / originalWidth, options.height / originalHeight);
            return {
                width: Math.max(1, Math.round(originalWidth * ratio)),
                height: Math.max(1, Math.round(originalHeight * ratio)),
            };
        }
        return { width: options.width, height: options.height };
    }
    if (options.width !== undefined) {
        const ratio = options.width / originalWidth;
        return { width: options.width, height: Math.max(1, Math.round(originalHeight * ratio)) };
    }
    if (options.height !== undefined) {
        const ratio = options.height / originalHeight;
        return { width: Math.max(1, Math.round(originalWidth * ratio)), height: options.height };
    }
    return null;
}

function isEightBit(colorType: JsColorType): boolean {
    return [
        JsColorType.L8,
        JsColorType.La8,
        JsColorType.Rgb8,
        JsColorType.Rgba8,
    ].includes(colorType);
}

function rebuildCroppedTransformer(transformer: Transformer): Transformer {
    const metadata = transformer.metadataSync();
    if (!isEightBit(metadata.colorType)) {
        return new Transformer(new Uint8Array(transformer.pngSync()));
    }

    const pixels = new Uint8Array(transformer.rawPixelsSync());
    const channels = Math.round(pixels.length / (metadata.width * metadata.height));
    if (channels < 1 || channels > 4) {
        return new Transformer(new Uint8Array(transformer.pngSync()));
    }

    const rgba = new Uint8Array(metadata.width * metadata.height * 4);
    for (let index = 0, offset = 0; index < pixels.length; index += channels, offset += 4) {
        if (channels === 1) {
            const value = pixels[index];
            rgba[offset] = value;
            rgba[offset + 1] = value;
            rgba[offset + 2] = value;
            rgba[offset + 3] = 255;
        } else if (channels === 2) {
            const value = pixels[index];
            rgba[offset] = value;
            rgba[offset + 1] = value;
            rgba[offset + 2] = value;
            rgba[offset + 3] = pixels[index + 1];
        } else if (channels === 3) {
            rgba[offset] = pixels[index];
            rgba[offset + 1] = pixels[index + 1];
            rgba[offset + 2] = pixels[index + 2];
            rgba[offset + 3] = 255;
        } else {
            rgba[offset] = pixels[index];
            rgba[offset + 1] = pixels[index + 1];
            rgba[offset + 2] = pixels[index + 2];
            rgba[offset + 3] = pixels[index + 3];
        }
    }

    return Transformer.fromRgbaPixels(rgba, metadata.width, metadata.height);
}

function luma(pixels: Uint8Array, index: number, channels: number): number {
    if (channels === 1 || channels === 2) return pixels[index] ?? 0;
    return 0.299 * (pixels[index] ?? 0) + 0.587 * (pixels[index + 1] ?? 0) + 0.114 * (pixels[index + 2] ?? 0);
}

function skinScore(pixels: Uint8Array, index: number, channels: number): number {
    if (channels < 3) return 0;
    const red = pixels[index] ?? 0;
    const green = pixels[index + 1] ?? 0;
    const blue = pixels[index + 2] ?? 0;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    if (max < 60 || min > 240) return 0;
    return red > 60 && red > green && red > blue && red - green > 15 && red - blue > 15 ? 1 : 0;
}

function smartCropRect(
    input: Uint8Array,
    originalWidth: number,
    originalHeight: number,
    targetWidth: number,
    targetHeight: number,
): CropRect {
    const targetAspect = targetWidth / targetHeight;
    const originalAspect = originalWidth / originalHeight;
    let cropWidth: number;
    let cropHeight: number;
    if (originalAspect > targetAspect) {
        cropHeight = originalHeight;
        cropWidth = Math.round(originalHeight * targetAspect);
    } else {
        cropWidth = originalWidth;
        cropHeight = Math.round(originalWidth / targetAspect);
    }

    if (cropWidth >= originalWidth && cropHeight >= originalHeight) {
        cropWidth = Math.min(cropWidth, originalWidth);
        cropHeight = Math.min(cropHeight, originalHeight);
        return {
            x: Math.floor((originalWidth - cropWidth) / 2),
            y: Math.floor((originalHeight - cropHeight) / 2),
            width: cropWidth,
            height: cropHeight,
        };
    }

    const maxSide = 256;
    const scale = maxSide / Math.max(originalWidth, originalHeight);
    const smallWidth = Math.max(1, Math.round(originalWidth * scale));
    const smallHeight = Math.max(1, Math.round(originalHeight * scale));
    const analysis = new Transformer(input).fastResize({
        width: smallWidth,
        height: smallHeight,
        filter: FastResizeFilter.Bilinear,
        fit: ResizeFit.Fill,
    });
    const meta = analysis.metadataSync();
    const pixels = new Uint8Array(analysis.rawPixelsSync());
    const channels = Math.max(1, Math.min(4, Math.round(pixels.length / (meta.width * meta.height))));
    const interest = new Float32Array(meta.width * meta.height);

    for (let y = 1; y < meta.height - 1; y += 1) {
        for (let x = 1; x < meta.width - 1; x += 1) {
            const index = (y * meta.width + x) * channels;
            const left = (y * meta.width + x - 1) * channels;
            const right = (y * meta.width + x + 1) * channels;
            const up = ((y - 1) * meta.width + x) * channels;
            const down = ((y + 1) * meta.width + x) * channels;
            const edge = Math.sqrt(
                (luma(pixels, right, channels) - luma(pixels, left, channels)) ** 2
                + (luma(pixels, down, channels) - luma(pixels, up, channels)) ** 2,
            );
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            const max = Math.max(red, green, blue);
            const min = Math.min(red, green, blue);
            const saturation = max > 0 ? (max - min) / max : 0;
            interest[y * meta.width + x] = edge * 0.5 + saturation * 24 + skinScore(pixels, index, channels) * 48;
        }
    }

    const integral = new Float64Array((meta.width + 1) * (meta.height + 1));
    for (let y = 0; y < meta.height; y += 1) {
        let rowSum = 0;
        for (let x = 0; x < meta.width; x += 1) {
            rowSum += interest[y * meta.width + x];
            integral[(y + 1) * (meta.width + 1) + x + 1] =
                integral[y * (meta.width + 1) + x + 1] + rowSum;
        }
    }

    const cropSmallWidth = clamp(Math.round((cropWidth * meta.width) / originalWidth), 1, meta.width);
    const cropSmallHeight = clamp(Math.round((cropHeight * meta.height) / originalHeight), 1, meta.height);
    let bestX = 0;
    let bestY = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let y = 0; y <= meta.height - cropSmallHeight; y += 1) {
        for (let x = 0; x <= meta.width - cropSmallWidth; x += 1) {
            const x2 = x + cropSmallWidth;
            const y2 = y + cropSmallHeight;
            const sum =
                integral[y2 * (meta.width + 1) + x2]
                - integral[y * (meta.width + 1) + x2]
                - integral[y2 * (meta.width + 1) + x]
                + integral[y * (meta.width + 1) + x];
            if (sum > bestScore) {
                bestScore = sum;
                bestX = x;
                bestY = y;
            }
        }
    }

    const cropX = Math.round((bestX * originalWidth) / meta.width);
    const cropY = Math.round((bestY * originalHeight) / meta.height);
    return {
        x: Math.min(cropX, originalWidth - cropWidth),
        y: Math.min(cropY, originalHeight - cropHeight),
        width: cropWidth,
        height: cropHeight,
    };
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function applyFilters(transformer: Transformer, options: TransformOptions): void {
    if (options.flipHorizontal) transformer.rotate(Orientation.MirrorHorizontal);
    if (options.flipVertical) transformer.rotate(Orientation.MirrorVertical);
    if (options.rotateDeg !== undefined) {
        const degrees = ((options.rotateDeg % 360) + 360) % 360;
        if (degrees === 90) transformer.rotate(Orientation.Rotate90Cw);
        else if (degrees === 180) transformer.rotate(Orientation.Rotate180);
        else if (degrees === 270) transformer.rotate(Orientation.Rotate270Cw);
    }
    if (options.grayscale) transformer.grayscale();
    if (options.invert) transformer.invert();
    if (options.contrast !== undefined && options.contrast !== 0) {
        transformer.adjustContrast(options.contrast);
    }
    if (options.brightness !== undefined && options.brightness !== 0) {
        transformer.brighten(options.brightness);
    }
    if (options.blurSigma !== undefined) transformer.blur(options.blurSigma);
    if (options.sharpenSigma !== undefined) transformer.unsharpen(options.sharpenSigma, 1);
}

function applyWatermarks(
    transformer: Transformer,
    options: TransformOptions,
    watermarkImage?: Uint8Array,
): void {
    if (!options.watermarkText && !watermarkImage) return;

    const base = transformer.metadataSync();

    if (options.watermarkText) {
        const overlay = new Transformer(
            renderTextWatermark(
                options.watermarkText,
                options.watermarkFontSize,
                options.watermarkColor,
                options.watermarkOpacity,
            ),
        );
        fitOverlay(overlay, base.width, base.height);
        const overlayMeta = overlay.metadataSync();
        transformer.composite(new Uint8Array(overlay.pngSync()), {
            left: anchorOffset(options.watermarkX, base.width, overlayMeta.width),
            top: anchorOffset(options.watermarkY, base.height, overlayMeta.height),
            opacity: options.watermarkOpacity,
            blend: BlendMode.Over,
        });
    }

    if (watermarkImage) {
        const overlay = new Transformer(watermarkImage);
        if (options.watermarkImageWidth !== undefined || options.watermarkImageHeight !== undefined) {
            overlay.fastResize({
                width: options.watermarkImageWidth ?? base.width,
                height: options.watermarkImageHeight ?? base.height,
                fit: ResizeFit.Inside,
            });
        }
        fitOverlay(overlay, base.width, base.height);
        const overlayMeta = overlay.metadataSync();
        transformer.composite(new Uint8Array(overlay.pngSync()), {
            left: anchorOffset(options.watermarkX, base.width, overlayMeta.width),
            top: anchorOffset(options.watermarkY, base.height, overlayMeta.height),
            opacity: options.watermarkOpacity,
            blend: BlendMode.Over,
        });
    }
}

function fitOverlay(overlay: Transformer, baseWidth: number, baseHeight: number): void {
    const meta = overlay.metadataSync();
    if (meta.width <= baseWidth && meta.height <= baseHeight) return;
    overlay.fastResize({ width: baseWidth, height: baseHeight, fit: ResizeFit.Inside });
}

function encodeImage(transformer: Transformer, options: TransformOptions): ProcessedImage {
    const quality = Math.min(100, Math.max(1, Math.round(options.quality)));
    switch (options.format ?? "webp") {
        case "avif":
            return {
                bytes: new Uint8Array(transformer.avifSync({ quality, speed: 6 })),
                contentType: "image/avif",
            };
        case "jpeg":
            return {
                bytes: new Uint8Array(transformer.jpegSync(quality)),
                contentType: "image/jpeg",
            };
        case "png": {
            const png = transformer.pngSync();
            let output = png;
            if (quality < 100) {
                try {
                    output = pngQuantizeSync(png, {
                        minQuality: Math.max(0, quality - 20),
                        maxQuality: quality,
                        speed: 5,
                    });
                } catch {
                    // Tiny or unusual images can be rejected by the quantizer; keep the PNG.
                }
            }
            return { bytes: new Uint8Array(output), contentType: "image/png" };
        }
        case "bmp":
            return {
                bytes: new Uint8Array(transformer.bmpSync()),
                contentType: "image/bmp",
            };
        case "tiff":
            return {
                bytes: new Uint8Array(transformer.tiffSync()),
                contentType: "image/tiff",
            };
        case "webp":
        default:
            return {
                bytes: new Uint8Array(transformer.webpSync(quality)),
                contentType: "image/webp",
            };
    }
}
