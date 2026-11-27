import {
    BlendMode,
    FastResizeFilter,
    Gravity as NapiGravity,
    JsColorType,
    Orientation,
    ResizeFit,
    Transformer,
} from "@napi-rs/image";
import { anchorOffset, renderTextWatermark } from "./watermark";
import type {
    BlurArea,
    CropOptions,
    DuotoneOptions,
    Gravity,
    GradientOptions,
    PaddingOptions,
    TargetFormat,
    TransformOptions,
    TrimOptions,
} from "./types";

export type CropRect = { x: number; y: number; width: number; height: number };
export type RgbaImage = { data: Uint8ClampedArray; width: number; height: number };

export function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function hasAlphaChannel(colorType: JsColorType): boolean {
    return [
        JsColorType.La8,
        JsColorType.Rgba8,
        JsColorType.La16,
        JsColorType.Rgba16,
        JsColorType.Rgba32F,
    ].includes(colorType);
}

export function isEightBit(colorType: JsColorType): boolean {
    return [
        JsColorType.L8,
        JsColorType.La8,
        JsColorType.Rgb8,
        JsColorType.Rgba8,
    ].includes(colorType);
}

export function cropTransformer(transformer: Transformer, rect: CropRect): Transformer {
    const metadata = transformer.metadataSync();
    const x = clamp(Math.round(rect.x), 0, metadata.width - 1);
    const y = clamp(Math.round(rect.y), 0, metadata.height - 1);
    const width = clamp(Math.round(rect.width), 1, metadata.width - x);
    const height = clamp(Math.round(rect.height), 1, metadata.height - y);
    if (x === 0 && y === 0 && width === metadata.width && height === metadata.height) {
        return transformer;
    }
    transformer.crop(x, y, width, height);
    return rebuildCroppedTransformer(transformer);
}

export function gravityRect(
    sourceWidth: number,
    sourceHeight: number,
    cropWidth: number,
    cropHeight: number,
    gravity?: Gravity,
): CropRect {
    const width = Math.max(1, Math.min(sourceWidth, Math.round(cropWidth)));
    const height = Math.max(1, Math.min(sourceHeight, Math.round(cropHeight)));
    let x = 0;
    let y = 0;
    const type = gravity?.type ?? "ce";

    if (type === "fp") {
        x = (gravity?.x ?? 0.5) * sourceWidth - width / 2;
        y = (gravity?.y ?? 0.5) * sourceHeight - height / 2;
    } else if (type === "sm" || type === "obj" || type === "objw") {
        x = (sourceWidth - width) / 2;
        y = (sourceHeight - height) / 2;
    } else {
        const horizontal = type.includes("ea") ? "end" : type.includes("we") ? "start" : "center";
        const vertical = type.startsWith("no") ? "start" : type.startsWith("so") ? "end" : "center";
        x = horizontal === "start" ? 0 : horizontal === "end" ? sourceWidth - width : (sourceWidth - width) / 2;
        y = vertical === "start" ? 0 : vertical === "end" ? sourceHeight - height : (sourceHeight - height) / 2;
    }

    const offsetX = gravity?.x ?? 0;
    const offsetY = gravity?.y ?? 0;
    if (offsetX || offsetY) {
        x += offsetX >= 1 || offsetX <= -1 ? offsetX : offsetX * (sourceWidth - width);
        y += offsetY >= 1 || offsetY <= -1 ? offsetY : offsetY * (sourceHeight - height);
    }

    return {
        x: Math.round(clamp(x, 0, sourceWidth - width)),
        y: Math.round(clamp(y, 0, sourceHeight - height)),
        width,
        height,
    };
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

    const rgba = new Uint8ClampedArray(metadata.width * metadata.height * 4);
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

export function toRgba(transformer: Transformer): RgbaImage {
    const metadata = transformer.metadataSync();
    const raw = transformer.rawPixelsSync();
    const colorType = metadata.colorType;
    const pixels = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const rgba = new Uint8ClampedArray(metadata.width * metadata.height * 4);

    const isFloat = colorType === JsColorType.Rgb32F || colorType === JsColorType.Rgba32F;
    const isSixteen = !isFloat && !isEightBit(colorType);
    const channels = colorType === JsColorType.L8 || colorType === JsColorType.L16
        ? 1
        : colorType === JsColorType.La8 || colorType === JsColorType.La16
            ? 2
            : colorType === JsColorType.Rgb8 || colorType === JsColorType.Rgb16 || colorType === JsColorType.Rgb32F
                ? 3
                : 4;
    const u16 = isSixteen ? new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 2) : undefined;
    const f32 = isFloat ? new Float32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength / 4) : undefined;

    for (let index = 0, offset = 0; index < metadata.width * metadata.height; index += 1, offset += 4) {
        const base = index * channels;
        let r: number;
        let g: number;
        let b: number;
        let a = 255;
        if (isFloat && f32) {
            r = clamp(Math.round(f32[base] * 255), 0, 255);
            g = clamp(Math.round(f32[base + 1] * 255), 0, 255);
            b = clamp(Math.round(f32[base + 2] * 255), 0, 255);
            if (channels === 4) a = clamp(Math.round(f32[base + 3] * 255), 0, 255);
        } else if (isSixteen && u16) {
            r = u16[base] >> 8;
            g = u16[base + 1] >> 8;
            b = u16[base + 2] >> 8;
            if (channels === 4) a = u16[base + 3] >> 8;
        } else if (channels === 1) {
            r = pixels[base];
            g = pixels[base];
            b = pixels[base];
        } else if (channels === 2) {
            r = pixels[base];
            g = pixels[base];
            b = pixels[base];
            a = pixels[base + 1];
        } else if (channels === 3) {
            r = pixels[base];
            g = pixels[base + 1];
            b = pixels[base + 2];
        } else {
            r = pixels[base];
            g = pixels[base + 1];
            b = pixels[base + 2];
            a = pixels[base + 3];
        }
        rgba[offset] = r;
        rgba[offset + 1] = g;
        rgba[offset + 2] = b;
        rgba[offset + 3] = a;
    }

    return { data: rgba, width: metadata.width, height: metadata.height };
}

export function trimImage(transformer: Transformer, options: TrimOptions): Transformer {
    const image = toRgba(transformer);
    const { data, width, height } = image;
    if (width <= 2 || height <= 2) return transformer;

    let background = parseColor(options.color, "#00000000");
    if (!options.color) {
        const corners = [
            pixelAt(data, 0, 0, width),
            pixelAt(data, width - 1, 0, width),
            pixelAt(data, 0, height - 1, width),
            pixelAt(data, width - 1, height - 1, width),
        ];
        background = {
            r: Math.round(corners.reduce((sum, pixel) => sum + pixel.r, 0) / corners.length),
            g: Math.round(corners.reduce((sum, pixel) => sum + pixel.g, 0) / corners.length),
            b: Math.round(corners.reduce((sum, pixel) => sum + pixel.b, 0) / corners.length),
            a: Math.round(corners.reduce((sum, pixel) => sum + pixel.a, 0) / corners.length),
        };
    }

    const threshold = Math.max(0, options.threshold);
    const matches = (x: number, y: number): boolean => {
        const pixel = pixelAt(data, x, y, width);
        const distance = Math.sqrt(
            (pixel.r - background.r) ** 2
            + (pixel.g - background.g) ** 2
            + (pixel.b - background.b) ** 2
            + (pixel.a - background.a) ** 2,
        );
        return distance <= threshold;
    };

    let top = 0;
    let bottom = height - 1;
    let left = 0;
    let right = width - 1;
    while (top < bottom && rowMatches(matches, top, width)) top += 1;
    while (bottom > top && rowMatches(matches, bottom, width)) bottom -= 1;
    while (left < right && columnMatches(matches, left, height)) left += 1;
    while (right > left && columnMatches(matches, right, height)) right -= 1;

    if (options.equalHorizontal) {
        const trim = Math.min(left, width - 1 - right);
        left = trim;
        right = width - 1 - trim;
    }
    if (options.equalVertical) {
        const trim = Math.min(top, height - 1 - bottom);
        top = trim;
        bottom = height - 1 - trim;
    }

    if (left === 0 && top === 0 && right === width - 1 && bottom === height - 1) {
        return transformer;
    }
    return cropTransformer(transformer, {
        x: left,
        y: top,
        width: right - left + 1,
        height: bottom - top + 1,
    });
}

function rowMatches(matches: (x: number, y: number) => boolean, y: number, width: number): boolean {
    for (let x = 0; x < width; x += 1) {
        if (!matches(x, y)) return false;
    }
    return true;
}

function columnMatches(
    matches: (x: number, y: number) => boolean,
    x: number,
    height: number,
): boolean {
    for (let y = 0; y < height; y += 1) {
        if (!matches(x, y)) return false;
    }
    return true;
}

function pixelAt(data: Uint8ClampedArray, x: number, y: number, width: number) {
    const index = (y * width + x) * 4;
    return { r: data[index], g: data[index + 1], b: data[index + 2], a: data[index + 3] };
}

export function extendImage(
    transformer: Transformer,
    options: TransformOptions,
    target: { width: number; height: number } | null,
): Transformer {
    const metadata = transformer.metadataSync();
    let targetWidth = target?.width ?? 0;
    let targetHeight = target?.height ?? 0;
    if (targetWidth === 0 && targetHeight === 0) return transformer;
    if (targetWidth === 0) targetWidth = Math.round(targetHeight * (metadata.width / metadata.height));
    if (targetHeight === 0) targetHeight = Math.round(targetWidth * (metadata.height / metadata.width));

    if (options.extendAspectRatio) {
        const aspect = targetWidth / targetHeight;
        if (metadata.width / metadata.height > aspect) {
            targetHeight = Math.round(targetWidth / aspect);
        } else {
            targetWidth = Math.round(targetHeight * aspect);
        }
    }

    if (metadata.width >= targetWidth && metadata.height >= targetHeight) return transformer;

    const background = parseColor(options.background, defaultBackground(options.format));
    const canvas = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    fillRgba(canvas, background);
    const gravity = options.extendGravity ?? options.gravity ?? { type: "ce" };
    const rect = gravityRect(targetWidth, targetHeight, metadata.width, metadata.height, gravity);
    const image = toRgba(transformer);
    copyRgba(image.data, image.width, image.height, canvas, targetWidth, rect.x, rect.y);
    return Transformer.fromRgbaPixels(canvas, targetWidth, targetHeight);
}

export function applyMinimumDimensions(transformer: Transformer, options: TransformOptions): Transformer {
    const metadata = transformer.metadataSync();
    const scale = Math.max(
        options.minWidth ? options.minWidth / metadata.width : 1,
        options.minHeight ? options.minHeight / metadata.height : 1,
    );
    if (scale <= 1) return transformer;
    const width = Math.max(1, Math.round(metadata.width * scale));
    const height = Math.max(1, Math.round(metadata.height * scale));
    transformer.fastResize({ width, height, fit: ResizeFit.Fill });
    return transformer;
}

export function applyPadding(
    transformer: Transformer,
    padding: PaddingOptions,
    backgroundValue?: string,
): Transformer {
    const metadata = transformer.metadataSync();
    const top = Math.max(0, Math.round(padding.top));
    const right = Math.max(0, Math.round(padding.right));
    const bottom = Math.max(0, Math.round(padding.bottom));
    const left = Math.max(0, Math.round(padding.left));
    const targetWidth = metadata.width + left + right;
    const targetHeight = metadata.height + top + bottom;
    if (targetWidth === metadata.width && targetHeight === metadata.height) return transformer;

    const canvas = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    fillRgba(canvas, parseColor(backgroundValue, defaultBackground(undefined)));
    const image = toRgba(transformer);
    copyRgba(image.data, image.width, image.height, canvas, targetWidth, left, top);
    return Transformer.fromRgbaPixels(canvas, targetWidth, targetHeight);
}

export function applyOrientation(transformer: Transformer, options: TransformOptions): void {
    if (options.rotateDeg !== undefined) {
        const degrees = ((options.rotateDeg % 360) + 360) % 360;
        if (degrees === 90) transformer.rotate(Orientation.Rotate90Cw);
        else if (degrees === 180) transformer.rotate(Orientation.Rotate180);
        else if (degrees === 270) transformer.rotate(Orientation.Rotate270Cw);
    }
    if (options.flipHorizontal) transformer.rotate(Orientation.MirrorHorizontal);
    if (options.flipVertical) transformer.rotate(Orientation.MirrorVertical);
}

export function applyFilters(transformer: Transformer, options: TransformOptions): void {
    if (options.grayscale) transformer.grayscale();
    if (options.invert) transformer.invert();
    if (options.contrast !== undefined && options.contrast !== 1) {
        transformer.adjustContrast((options.contrast - 1) * 100);
    }
    if (options.brightness !== undefined && options.brightness !== 0) {
        transformer.brighten(options.brightness);
    }
    if (options.saturation !== undefined && options.saturation !== 1) {
        replacePixels(transformer, applySaturation(transformer, options.saturation));
    }
    if (options.gamma !== undefined && options.gamma > 0 && options.gamma !== 1) {
        replacePixels(transformer, applyGamma(transformer, options.gamma));
    }
    if (options.monochrome && options.monochrome.intensity > 0) {
        replacePixels(transformer, applyMonochrome(transformer, options.monochrome.intensity, options.monochrome.color));
    }
    if (options.duotone && options.duotone.intensity > 0) {
        replacePixels(transformer, applyDuotone(transformer, options.duotone));
    }
    if (options.pixelateSize && options.pixelateSize > 1) {
        replacePixels(transformer, applyPixelate(transformer, Math.round(options.pixelateSize)));
    }
    if (options.blurSigma !== undefined) transformer.blur(options.blurSigma);
    if (options.unsharpMasking) {
        const sigma = options.unsharpMasking.weight > 0 ? options.unsharpMasking.weight : 1;
        const threshold = options.unsharpMasking.divider > 0 ? options.unsharpMasking.divider : 1;
        transformer.unsharpen(sigma, threshold);
    } else if (options.sharpenSigma !== undefined) {
        transformer.unsharpen(options.sharpenSigma, 1);
    }
    if (options.blurAreas?.length) {
        applyBlurAreas(transformer, options.blurAreas);
    }
    if (options.progressiveBlur && options.progressiveBlur.sigma > 0) {
        applyProgressiveBlur(
            transformer,
            options.progressiveBlur.sigma,
            options.progressiveBlur.direction,
            options.progressiveBlur.start,
            options.progressiveBlur.stop,
        );
    }
    if (options.colorize && options.colorize.opacity > 0) {
        applyColorize(transformer, options.colorize.color, options.colorize.opacity, options.colorize.keepAlpha);
    }
    if (options.gradient && options.gradient.opacity > 0) {
        applyGradient(transformer, options.gradient);
    }
}

function replacePixels(transformer: Transformer, replacement: Transformer): void {
    transformer.overlay(new Uint8Array(replacement.pngSync()), 0, 0);
}

function mapPixels(
    transformer: Transformer,
    map: (pixel: { r: number; g: number; b: number; a: number }) => { r: number; g: number; b: number; a: number },
): Transformer {
    const image = toRgba(transformer);
    for (let index = 0; index < image.data.length; index += 4) {
        const pixel = map({
            r: image.data[index],
            g: image.data[index + 1],
            b: image.data[index + 2],
            a: image.data[index + 3],
        });
        image.data[index] = pixel.r;
        image.data[index + 1] = pixel.g;
        image.data[index + 2] = pixel.b;
        image.data[index + 3] = pixel.a;
    }
    return Transformer.fromRgbaPixels(image.data, image.width, image.height);
}

function applySaturation(transformer: Transformer, saturation: number): Transformer {
    return mapPixels(transformer, (pixel) => {
        const luma = 0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b;
        return {
            r: clamp(Math.round(luma + (pixel.r - luma) * saturation), 0, 255),
            g: clamp(Math.round(luma + (pixel.g - luma) * saturation), 0, 255),
            b: clamp(Math.round(luma + (pixel.b - luma) * saturation), 0, 255),
            a: pixel.a,
        };
    });
}

function applyGamma(transformer: Transformer, gamma: number): Transformer {
    return mapPixels(transformer, (pixel) => ({
        r: clamp(Math.round(255 * (pixel.r / 255) ** gamma), 0, 255),
        g: clamp(Math.round(255 * (pixel.g / 255) ** gamma), 0, 255),
        b: clamp(Math.round(255 * (pixel.b / 255) ** gamma), 0, 255),
        a: pixel.a,
    }));
}

function applyMonochrome(transformer: Transformer, intensity: number, color?: string): Transformer {
    const tint = parseColor(color, "#b3b3b3");
    return mapPixels(transformer, (pixel) => {
        const luma = (0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b) / 255;
        return {
            r: clamp(Math.round(pixel.r + (tint.r * luma - pixel.r) * intensity), 0, 255),
            g: clamp(Math.round(pixel.g + (tint.g * luma - pixel.g) * intensity), 0, 255),
            b: clamp(Math.round(pixel.b + (tint.b * luma - pixel.b) * intensity), 0, 255),
            a: pixel.a,
        };
    });
}

function applyDuotone(transformer: Transformer, options: DuotoneOptions): Transformer {
    const dark = parseColor(options.dark, "#000000");
    const light = parseColor(options.light, "#ffffff");
    return mapPixels(transformer, (pixel) => {
        const luma = (0.299 * pixel.r + 0.587 * pixel.g + 0.114 * pixel.b) / 255;
        const target = {
            r: dark.r + (light.r - dark.r) * luma,
            g: dark.g + (light.g - dark.g) * luma,
            b: dark.b + (light.b - dark.b) * luma,
        };
        return {
            r: clamp(Math.round(pixel.r + (target.r - pixel.r) * options.intensity), 0, 255),
            g: clamp(Math.round(pixel.g + (target.g - pixel.g) * options.intensity), 0, 255),
            b: clamp(Math.round(pixel.b + (target.b - pixel.b) * options.intensity), 0, 255),
            a: pixel.a,
        };
    });
}

function applyPixelate(transformer: Transformer, size: number): Transformer {
    const image = toRgba(transformer);
    for (let y = 0; y < image.height; y += size) {
        for (let x = 0; x < image.width; x += size) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;
            let count = 0;
            for (let py = y; py < Math.min(y + size, image.height); py += 1) {
                for (let px = x; px < Math.min(x + size, image.width); px += 1) {
                    const index = (py * image.width + px) * 4;
                    r += image.data[index];
                    g += image.data[index + 1];
                    b += image.data[index + 2];
                    a += image.data[index + 3];
                    count += 1;
                }
            }
            if (count === 0) continue;
            r = Math.round(r / count);
            g = Math.round(g / count);
            b = Math.round(b / count);
            a = Math.round(a / count);
            for (let py = y; py < Math.min(y + size, image.height); py += 1) {
                for (let px = x; px < Math.min(x + size, image.width); px += 1) {
                    const index = (py * image.width + px) * 4;
                    image.data[index] = r;
                    image.data[index + 1] = g;
                    image.data[index + 2] = b;
                    image.data[index + 3] = a;
                }
            }
        }
    }
    return Transformer.fromRgbaPixels(image.data, image.width, image.height);
}

function applyBlurAreas(transformer: Transformer, areas: BlurArea[]): void {
    const metadata = transformer.metadataSync();
    const blurred = new Transformer(new Uint8Array(transformer.pngSync())).blur(2);
    for (const area of areas) {
        const left = clamp(Math.round(area.left * metadata.width), 0, metadata.width - 1);
        const top = clamp(Math.round(area.top * metadata.height), 0, metadata.height - 1);
        const width = clamp(Math.round(area.width * metadata.width), 1, metadata.width - left);
        const height = clamp(Math.round(area.height * metadata.height), 1, metadata.height - top);
        if (width <= 0 || height <= 0) continue;
        const region = new Transformer(new Uint8Array(blurred.pngSync())).crop(left, top, width, height);
        transformer.composite(new Uint8Array(region.pngSync()), { left, top, blend: BlendMode.Over });
    }
}

function applyProgressiveBlur(
    transformer: Transformer,
    sigma: number,
    direction: number,
    start: number,
    stop: number,
): void {
    const image = toRgba(transformer);
    const blurred = new Transformer(new Uint8Array(transformer.pngSync())).blur(sigma);
    const blurredImage = toRgba(blurred);
    const normalizedDirection = ((Math.round(direction) % 4) + 4) % 4;
    const horizontal = normalizedDirection === 0 || normalizedDirection === 1 ? 1 : 0;
    const vertical = normalizedDirection === 2 || normalizedDirection === 3 ? 1 : 0;
    const reverseX = normalizedDirection === 1;
    const reverseY = normalizedDirection === 3;
    const startAt = clamp(start, 0, 1);
    const stopAt = clamp(stop, 0, 1);
    for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const index = (y * image.width + x) * 4;
            const xPosition = x / Math.max(1, image.width - 1);
            const yPosition = y / Math.max(1, image.height - 1);
            const factor = clamp(
                ((reverseX ? 1 - xPosition : xPosition) * horizontal
                    + (reverseY ? 1 - yPosition : yPosition) * vertical
                    - startAt)
                    / Math.max(0.0001, stopAt - startAt),
                0,
                1,
            );
            image.data[index] = Math.round(image.data[index] + (blurredImage.data[index] - image.data[index]) * factor);
            image.data[index + 1] = Math.round(image.data[index + 1] + (blurredImage.data[index + 1] - image.data[index + 1]) * factor);
            image.data[index + 2] = Math.round(image.data[index + 2] + (blurredImage.data[index + 2] - image.data[index + 2]) * factor);
            image.data[index + 3] = Math.round(image.data[index + 3] + (blurredImage.data[index + 3] - image.data[index + 3]) * factor);
        }
    }
    replacePixels(transformer, Transformer.fromRgbaPixels(image.data, image.width, image.height));
}

function applyColorize(transformer: Transformer, color: string, opacity: number, keepAlpha?: boolean): void {
    const tint = parseColor(color, "#000000");
    const image = toRgba(transformer);
    for (let index = 0; index < image.data.length; index += 4) {
        image.data[index] = Math.round(image.data[index] + (tint.r - image.data[index]) * opacity);
        image.data[index + 1] = Math.round(image.data[index + 1] + (tint.g - image.data[index + 1]) * opacity);
        image.data[index + 2] = Math.round(image.data[index + 2] + (tint.b - image.data[index + 2]) * opacity);
        if (!keepAlpha) image.data[index + 3] = 255;
    }
    replacePixels(transformer, Transformer.fromRgbaPixels(image.data, image.width, image.height));
}

function applyGradient(transformer: Transformer, gradient: GradientOptions): void {
    const tint = parseColor(gradient.color, "#000000");
    const image = toRgba(transformer);
    const radians = (((gradient.direction % 360) + 360) % 360) * (Math.PI / 180);
    const horizontal = Math.abs(Math.sin(radians));
    const vertical = Math.abs(Math.cos(radians));
    const start = clamp(gradient.start, 0, 1);
    const stop = clamp(gradient.stop, 0, 1);
    for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const position = (x / Math.max(1, image.width - 1)) * horizontal
                + (y / Math.max(1, image.height - 1)) * vertical;
            const factor = position <= start
                ? 0
                : position >= stop
                    ? 1
                    : (position - start) / Math.max(0.0001, stop - start);
            const index = (y * image.width + x) * 4;
            const alpha = gradient.opacity * factor;
            image.data[index] = Math.round(image.data[index] + (tint.r - image.data[index]) * alpha);
            image.data[index + 1] = Math.round(image.data[index + 1] + (tint.g - image.data[index + 1]) * alpha);
            image.data[index + 2] = Math.round(image.data[index + 2] + (tint.b - image.data[index + 2]) * alpha);
        }
    }
    replacePixels(transformer, Transformer.fromRgbaPixels(image.data, image.width, image.height));
}

export function flattenImage(transformer: Transformer, backgroundValue?: string): Transformer {
    const background = parseColor(backgroundValue, "#ffffff");
    return mapPixels(transformer, (pixel) => {
        const alpha = pixel.a / 255;
        return {
            r: Math.round(pixel.r * alpha + background.r * (1 - alpha)),
            g: Math.round(pixel.g * alpha + background.g * (1 - alpha)),
            b: Math.round(pixel.b * alpha + background.b * (1 - alpha)),
            a: 255,
        };
    });
}

export function applyWatermarks(
    transformer: Transformer,
    options: TransformOptions,
    watermarkImage?: Uint8Array,
): void {
    const image = watermarkImage ?? options.watermarkImage;
    if (!options.watermarkText && !image) return;

    if (options.watermarkPosition) {
        applyImgproxyWatermark(transformer, options, image);
        return;
    }

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

    if (image) {
        const overlay = new Transformer(image);
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

function applyImgproxyWatermark(
    transformer: Transformer,
    options: TransformOptions,
    image?: Uint8Array,
): void {
    const base = transformer.metadataSync();
    let overlay: Transformer | undefined;

    if (options.watermarkText) {
        overlay = new Transformer(
            renderTextWatermark(
                options.watermarkText,
                options.watermarkFontSize,
                options.watermarkColor,
                1,
            ),
        );
    } else if (image) {
        overlay = new Transformer(image);
    }
    if (!overlay) return;

    if (options.watermarkWidth !== undefined || options.watermarkHeight !== undefined) {
        overlay.fastResize({
            width: options.watermarkWidth ?? base.width,
            height: options.watermarkHeight ?? base.height,
            fit: ResizeFit.Inside,
        });
    } else if (options.watermarkScale && options.watermarkScale > 0) {
        overlay.fastResize({
            width: Math.max(1, Math.round(base.width * options.watermarkScale)),
            height: Math.max(1, Math.round(base.height * options.watermarkScale)),
            fit: ResizeFit.Inside,
        });
    } else {
        fitOverlay(overlay, base.width, base.height);
    }

    if (options.watermarkRotate) {
        const degrees = ((options.watermarkRotate % 360) + 360) % 360;
        if (degrees === 90) overlay.rotate(Orientation.Rotate90Cw);
        else if (degrees === 180) overlay.rotate(Orientation.Rotate180);
        else if (degrees === 270) overlay.rotate(Orientation.Rotate270Cw);
    }

    const overlayMeta = overlay.metadataSync();
    const position = options.watermarkPosition ?? "ce";
    const offsetX = options.watermarkOffsetX ?? 0;
    const offsetY = options.watermarkOffsetY ?? 0;
    const opacity = clamp(options.watermarkOpacity, 0, 1);

    if (options.watermarkShadow && options.watermarkShadow > 0) {
        const shadow = createShadow(overlay, options.watermarkShadow, opacity);
        if (shadow) {
            const shadowMeta = shadow.metadataSync();
            const shadowRect = gravityRect(
                base.width,
                base.height,
                shadowMeta.width,
                shadowMeta.height,
                { type: position, x: offsetX, y: offsetY },
            );
            transformer.composite(new Uint8Array(shadow.pngSync()), {
                left: shadowRect.x,
                top: shadowRect.y,
                opacity: 0.35 * opacity,
                blend: BlendMode.Over,
            });
        }
    }

    if (position === "re" || position === "ch") {
        transformer.composite(new Uint8Array(overlay.pngSync()), {
            gravity: NapiGravity.Center,
            tile: true,
            opacity,
            blend: BlendMode.Over,
        });
        return;
    }

    const rect = gravityRect(
        base.width,
        base.height,
        overlayMeta.width,
        overlayMeta.height,
        { type: position, x: offsetX, y: offsetY },
    );
    transformer.composite(new Uint8Array(overlay.pngSync()), {
        left: rect.x,
        top: rect.y,
        opacity,
        blend: BlendMode.Over,
    });
}

function createShadow(overlay: Transformer, sigma: number, opacity: number): Transformer | undefined {
    try {
        const image = toRgba(overlay);
        for (let index = 0; index < image.data.length; index += 4) {
            image.data[index] = 0;
            image.data[index + 1] = 0;
            image.data[index + 2] = 0;
            image.data[index + 3] = Math.round(image.data[index + 3] * 0.55 * opacity);
        }
        const shadow = Transformer.fromRgbaPixels(image.data, image.width, image.height);
        if (sigma > 0) shadow.blur(Math.min(sigma, 8));
        return shadow;
    } catch {
        return undefined;
    }
}

function fitOverlay(overlay: Transformer, baseWidth: number, baseHeight: number): void {
    const meta = overlay.metadataSync();
    if (meta.width <= baseWidth && meta.height <= baseHeight) return;
    overlay.fastResize({ width: baseWidth, height: baseHeight, fit: ResizeFit.Inside });
}

export function formatSupportsAlpha(format?: TargetFormat): boolean {
    return format === "png"
        || format === "webp"
        || format === "avif"
        || format === "gif"
        || format === "tiff"
        || format === "ico"
        || format === undefined;
}

export function defaultBackground(format?: TargetFormat): string {
    return formatSupportsAlpha(format) ? "#00000000" : "#ffffff";
}

export function parseColor(value: string | undefined, fallback: string): { r: number; g: number; b: number; a: number } {
    const normalized = value?.trim().toLowerCase() || fallback.toLowerCase();
    if (normalized === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    const hex = normalized.startsWith("#") ? normalized.slice(1) : normalized;
    if (/^[0-9a-f]{3}$/.test(hex)) {
        return {
            r: parseInt(hex[0] + hex[0], 16),
            g: parseInt(hex[1] + hex[1], 16),
            b: parseInt(hex[2] + hex[2], 16),
            a: 255,
        };
    }
    if (/^[0-9a-f]{6}$/.test(hex)) {
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: 255,
        };
    }
    if (/^[0-9a-f]{8}$/.test(hex)) {
        return {
            r: parseInt(hex.slice(0, 2), 16),
            g: parseInt(hex.slice(2, 4), 16),
            b: parseInt(hex.slice(4, 6), 16),
            a: parseInt(hex.slice(6, 8), 16),
        };
    }
    const rgb = normalized.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/);
    if (rgb) {
        return {
            r: clamp(parseInt(rgb[1], 10), 0, 255),
            g: clamp(parseInt(rgb[2], 10), 0, 255),
            b: clamp(rgb[3] ? parseInt(rgb[3], 10) : 0, 0, 255),
            a: rgb[4] === undefined ? 255 : clamp(Math.round(parseFloat(rgb[4]) * 255), 0, 255),
        };
    }
    const named: Record<string, string> = {
        white: "#ffffff",
        black: "#000000",
        red: "#ff0000",
        green: "#00ff00",
        blue: "#0000ff",
        transparent: "#00000000",
    };
    if (named[normalized]) return parseColor(named[normalized], fallback);
    return parseColor(fallback, "#ffffff");
}

function fillRgba(data: Uint8ClampedArray, color: { r: number; g: number; b: number; a: number }): void {
    for (let index = 0; index < data.length; index += 4) {
        data[index] = color.r;
        data[index + 1] = color.g;
        data[index + 2] = color.b;
        data[index + 3] = color.a;
    }
}

function copyRgba(
    source: Uint8ClampedArray,
    sourceWidth: number,
    sourceHeight: number,
    target: Uint8ClampedArray,
    targetWidth: number,
    offsetX: number,
    offsetY: number,
): void {
    for (let y = 0; y < sourceHeight; y += 1) {
        const targetY = offsetY + y;
        if (targetY < 0) continue;
        for (let x = 0; x < sourceWidth; x += 1) {
            const targetX = offsetX + x;
            if (targetX < 0 || targetX >= targetWidth) continue;
            const sourceIndex = (y * sourceWidth + x) * 4;
            const targetIndex = (targetY * targetWidth + targetX) * 4;
            target[targetIndex] = source[sourceIndex];
            target[targetIndex + 1] = source[sourceIndex + 1];
            target[targetIndex + 2] = source[sourceIndex + 2];
            target[targetIndex + 3] = source[sourceIndex + 3];
        }
    }
}

export function smartCropRect(
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
