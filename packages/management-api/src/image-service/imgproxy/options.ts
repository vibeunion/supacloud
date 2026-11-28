import { ImgproxyError } from "./errors";
import type { ImgproxyConfig } from "./config";
import type { SourceRef } from "./url";
import type {
    Gravity,
    GravityType,
    TargetFormat,
    TransformOptions,
} from "../types";

const TARGET_FORMATS = new Set([
    "jpg",
    "jpeg",
    "png",
    "webp",
    "avif",
    "gif",
    "bmp",
    "tiff",
    "tif",
    "ico",
]);

const GRAVITY_TYPES = new Set([
    "no",
    "so",
    "ea",
    "we",
    "noea",
    "nowe",
    "soea",
    "sowe",
    "ce",
    "sm",
    "fp",
    "obj",
    "objw",
]);

export type InfoOptions = {
    size: boolean;
    format: boolean;
    dimensions: boolean;
    exif: boolean;
    iptc: boolean;
    xmp: boolean;
    videoMeta: boolean;
    detectObjects: boolean;
    classify: boolean;
    colorspace: boolean;
    dominantColors: boolean;
    blurhash: boolean;
};

export type Hashsum = {
    type: string;
    hash: string;
};

export type ImgproxyRequest = {
    transform: TransformOptions;
    source: SourceRef;
    extension?: string;
    info: boolean;
    infoOptions: InfoOptions;
    bestFormat: boolean;
    expires?: number;
    filename?: string;
    returnAttachment: boolean;
    raw: boolean;
    disableAnimation: boolean;
    skipProcessing: TargetFormat[];
    hashsum?: Hashsum;
    maxSrcResolution: number;
    maxSrcFileSize: number;
    maxResultDimension: number;
    maxAnimationFrames: number;
    maxAnimationFrameResolution: number;
    videoThumbnailSecond?: number;
    pdfPage?: number;
    fallbackImageUrl?: string;
    watermarkUrl?: string;
    cachebuster?: string;
};

function splitOption(segment: string, separator: string): { name: string; args: string[] } {
    const parts = segment.split(separator);
    return { name: parts[0] ?? "", args: parts.slice(1) };
}

function floatValue(value: string | undefined, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function intValue(value: string | undefined, fallback: number): number {
    if (value === undefined || value === "") return fallback;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : fallback;
}

function boolValue(value: string | undefined, fallback = false): boolean {
    if (value === undefined || value === "") return fallback;
    return value === "1" || value.toLowerCase() === "t" || value.toLowerCase() === "true";
}

function decodeBase64Url(value: string): string {
    try {
        return Buffer.from(value, "base64url").toString("utf8");
    } catch {
        throw new ImgproxyError("Invalid URL-safe Base64 value", 400);
    }
}

function stripMarkup(value: string): string {
    return value
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, "\"")
        .replace(/&#39;/g, "'");
}

function parseGravity(args: string[], startIndex = 0): Gravity | undefined {
    const type = args[startIndex] as GravityType;
    if (!type) return undefined;
    if (!GRAVITY_TYPES.has(type)) {
        throw new ImgproxyError(`Unknown gravity type: ${type}`, 400);
    }
    if (type === "fp") {
        return {
            type,
            x: floatValue(args[startIndex + 1], 0.5),
            y: floatValue(args[startIndex + 2], 0.5),
        };
    }
    if (type === "obj" || type === "objw") {
        const values = args.slice(startIndex + 1);
        const classes: string[] = [];
        const weights: number[] = [];
        for (let index = 0; index < values.length; index += 1) {
            classes.push(values[index]);
            if (type === "objw") {
                weights.push(floatValue(values[index + 1], 1));
                index += 1;
            } else {
                weights.push(1);
            }
        }
        return { type, classes, weights };
    }
    return {
        type,
        x: floatValue(args[startIndex + 1], 0),
        y: floatValue(args[startIndex + 2], 0),
    };
}

function parseBackground(args: string[]): string | undefined {
    if (args.length >= 3 && args.slice(0, 3).every((value) => /^\d+$/.test(value))) {
        const r = Math.min(255, Math.max(0, intValue(args[0], 0)));
        const g = Math.min(255, Math.max(0, intValue(args[1], 0)));
        const b = Math.min(255, Math.max(0, intValue(args[2], 0)));
        return `#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    }
    return args[0] || undefined;
}

function parsePadding(args: string[]): TransformOptions["padding"] {
    const values = args.filter((value) => value !== "").map((value) => floatValue(value, 0));
    if (values.length === 0) return { top: 0, right: 0, bottom: 0, left: 0 };
    if (values.length === 1) {
        return { top: values[0], right: values[0], bottom: values[0], left: values[0] };
    }
    if (values.length === 2) {
        return { top: values[0], right: values[1], bottom: values[0], left: values[1] };
    }
    if (values.length === 3) {
        return { top: values[0], right: values[1], bottom: values[2], left: values[1] };
    }
    return { top: values[0], right: values[1], bottom: values[2], left: values[3] };
}

function normalizeFormat(value: string): TargetFormat | undefined {
    const normalized = value.toLowerCase();
    if (normalized === "jpg") return "jpeg";
    if (normalized === "tif") return "tiff";
    return TARGET_FORMATS.has(normalized) ? normalized as TargetFormat : undefined;
}

function defaultTransform(config: ImgproxyConfig): TransformOptions {
    return {
        fitIn: false,
        stretch: false,
        smart: false,
        flipHorizontal: false,
        flipVertical: false,
        quality: config.quality,
        grayscale: false,
        invert: false,
        isMeta: false,
        watermarkX: "center",
        watermarkY: "end",
        watermarkOpacity: 1,
        watermarkColor: "#000000",
        watermarkFontSize: 16,
        resizeType: "fit",
        enlarge: false,
        autoRotate: config.autoRotate,
    };
}

function defaultInfoOptions(): InfoOptions {
    return {
        size: true,
        format: true,
        dimensions: true,
        exif: true,
        iptc: false,
        xmp: false,
        videoMeta: false,
        detectObjects: false,
        classify: false,
        colorspace: true,
        dominantColors: false,
        blurhash: false,
    };
}

function applyPresets(
    segments: string[],
    config: ImgproxyConfig,
    applyDefault = true,
): string[] {
    const requested: string[] = [];
    const regular: string[] = [];
    for (const segment of segments) {
        const { name, args } = splitOption(segment, config.argsSeparator);
        if (name === "preset" || name === "pr") {
            requested.push(...args.map((value) => value.trim()).filter(Boolean));
        } else {
            regular.push(segment);
        }
    }

    const applied = new Set<string>();
    const expanded: string[] = [];
    const applyPreset = (name: string): void => {
        if (!name || applied.has(name)) return;
        const definition = config.presets.get(name);
        if (definition === undefined) {
            throw new ImgproxyError(`Unknown preset: ${name}`, 400);
        }
        applied.add(name);
        for (const option of definition.split("/").map((value) => value.trim()).filter(Boolean)) {
            expanded.push(option);
        }
    };

    if (applyDefault && config.presets.has("default")) applyPreset("default");
    for (const name of requested) applyPreset(name);

    if (config.onlyPresets && regular.length > 0) {
        throw new ImgproxyError("Only preset options are allowed by IMGPROXY_ONLY_PRESETS", 400);
    }
    return [...expanded, ...regular];
}

export function parseProcessingOptions(
    segments: string[],
    source: SourceRef,
    config: ImgproxyConfig,
): ImgproxyRequest {
    const transform = defaultTransform(config);
    const request: ImgproxyRequest = {
        transform,
        source,
        extension: source.extension,
        info: false,
        infoOptions: defaultInfoOptions(),
        bestFormat: false,
        returnAttachment: config.returnAttachment,
        raw: false,
        disableAnimation: false,
        skipProcessing: [],
        maxSrcResolution: config.maxSrcResolution,
        maxSrcFileSize: config.maxSrcFileSize,
        maxResultDimension: config.maxResultDimension,
        maxAnimationFrames: config.maxAnimationFrames,
        maxAnimationFrameResolution: config.maxAnimationFrameResolution,
        videoThumbnailSecond: undefined,
        pdfPage: undefined,
    };

    for (const segment of applyPresets(segments, config)) {
        const { name, args } = splitOption(segment, config.argsSeparator);
        switch (name) {
            case "resize":
            case "rs":
                if (args[0]) transform.resizeType = parseResizeType(args[0]);
                if (args[1] !== undefined) transform.width = intValue(args[1], 0) || undefined;
                if (args[2] !== undefined) transform.height = intValue(args[2], 0) || undefined;
                if (args[3] !== undefined) transform.enlarge = boolValue(args[3], false);
                if (args[4] !== undefined) transform.extend = boolValue(args[4], false);
                break;
            case "size":
            case "s":
                if (args[0] !== undefined) transform.width = intValue(args[0], 0) || undefined;
                if (args[1] !== undefined) transform.height = intValue(args[1], 0) || undefined;
                if (args[2] !== undefined) transform.enlarge = boolValue(args[2], false);
                if (args[3] !== undefined) transform.extend = boolValue(args[3], false);
                break;
            case "resizing_type":
            case "rt":
                transform.resizeType = parseResizeType(args[0] ?? "fit");
                break;
            case "resizing_algorithm":
            case "ra": {
                const algorithm = args[0] ?? "lanczos3";
                if (!["nearest", "linear", "cubic", "lanczos2", "lanczos3"].includes(algorithm)) {
                    throw new ImgproxyError(`Unknown resizing algorithm: ${algorithm}`, 400);
                }
                transform.resizeFilter = algorithm as TransformOptions["resizeFilter"];
                break;
            }
            case "width":
            case "w":
                transform.width = intValue(args[0], 0) || undefined;
                break;
            case "height":
            case "h":
                transform.height = intValue(args[0], 0) || undefined;
                break;
            case "min-width":
            case "mw":
                transform.minWidth = Math.max(0, intValue(args[0], 0)) || undefined;
                break;
            case "min-height":
            case "mh":
                transform.minHeight = Math.max(0, intValue(args[0], 0)) || undefined;
                break;
            case "zoom":
            case "z": {
                const zoom = floatValue(args[0], 1);
                if (zoom <= 0) throw new ImgproxyError("zoom must be greater than 0", 400);
                transform.zoom = zoom;
                break;
            }
            case "dpr": {
                const dpr = floatValue(args[0], 1);
                if (dpr <= 0) throw new ImgproxyError("dpr must be greater than 0", 400);
                transform.dpr = dpr;
                break;
            }
            case "enlarge":
            case "el":
                transform.enlarge = boolValue(args[0], false);
                break;
            case "extend":
            case "ex":
                transform.extend = boolValue(args[0], false);
                transform.extendGravity = parseGravity(args, 1);
                break;
            case "extend_aspect_ratio":
            case "extend_ar":
            case "exar":
                transform.extend = boolValue(args[0], false);
                transform.extendAspectRatio = boolValue(args[0], false);
                transform.extendGravity = parseGravity(args, 1);
                break;
            case "gravity":
            case "g":
                transform.gravity = parseGravity(args);
                break;
            case "objects_position":
            case "obj_pos":
            case "op":
                transform.objectsPosition = parseGravity(args);
                break;
            case "crop":
            case "c":
                transform.crop = {
                    width: floatValue(args[0], 0),
                    height: floatValue(args[1], 0),
                    gravity: parseGravity(args, 2),
                };
                break;
            case "crop_aspect_ratio":
            case "crop_ar":
            case "car":
                transform.cropAspectRatio = floatValue(args[0], 0);
                break;
            case "trim":
            case "t":
                transform.trim = {
                    threshold: floatValue(args[0], 10),
                    color: args[1],
                    equalHorizontal: boolValue(args[2], false),
                    equalVertical: boolValue(args[3], false),
                };
                break;
            case "padding":
            case "pd":
                transform.padding = parsePadding(args);
                break;
            case "auto_rotate":
            case "ar":
                transform.autoRotate = boolValue(args[0], true);
                break;
            case "rotate":
            case "rot":
                transform.rotateDeg = intValue(args[0], 0);
                break;
            case "flip":
            case "fl":
                transform.flipHorizontal = boolValue(args[0], false);
                transform.flipVertical = boolValue(args[1], false);
                break;
            case "background":
            case "bg":
                transform.background = parseBackground(args);
                break;
            case "background_alpha":
            case "bga":
                transform.backgroundAlpha = Math.min(1, Math.max(0, floatValue(args[0], 1)));
                break;
            case "adjust":
            case "a":
                transform.brightness = intValue(args[0], 0);
                transform.contrast = floatValue(args[1], 1);
                transform.saturation = floatValue(args[2], 1);
                break;
            case "brightness":
            case "br":
                transform.brightness = Math.min(255, Math.max(-255, intValue(args[0], 0)));
                break;
            case "contrast":
            case "co":
                transform.contrast = floatValue(args[0], 1);
                break;
            case "saturation":
            case "sa":
                transform.saturation = floatValue(args[0], 1);
                break;
            case "monochrome":
            case "mc":
                transform.monochrome = {
                    intensity: Math.min(1, Math.max(0, floatValue(args[0], 0))),
                    color: args[1],
                };
                break;
            case "duotone":
            case "dt":
                transform.duotone = {
                    intensity: Math.min(1, Math.max(0, floatValue(args[0], 0))),
                    dark: args[1] ?? "#000000",
                    light: args[2] ?? "#ffffff",
                };
                break;
            case "blur":
            case "bl":
                transform.blurSigma = Math.max(0, floatValue(args[0], 0)) || undefined;
                break;
            case "sharpen":
            case "sh":
                transform.sharpenSigma = Math.max(0, floatValue(args[0], 0)) || undefined;
                break;
            case "pixelate":
            case "pix":
                transform.pixelateSize = Math.max(0, floatValue(args[0], 0)) || undefined;
                break;
            case "unsharp_masking":
            case "ush":
                transform.unsharpMasking = {
                    mode: args[0],
                    weight: floatValue(args[1], 1),
                    divider: floatValue(args[2], 4),
                };
                break;
            case "blur_areas":
            case "ba": {
                const sigma = floatValue(args[0], 2);
                const areas = [];
                for (let index = 1; index + 3 < args.length; index += 4) {
                    areas.push({
                        left: floatValue(args[index], 0),
                        top: floatValue(args[index + 1], 0),
                        width: floatValue(args[index + 2], 0),
                        height: floatValue(args[index + 3], 0),
                    });
                }
                if (areas.length > 0) {
                    transform.blurAreas = areas;
                    transform.blurSigma = transform.blurSigma ?? sigma;
                }
                break;
            }
            case "progressive_blur":
            case "pbl":
                transform.progressiveBlur = {
                    sigma: floatValue(args[0], 0),
                    direction: floatValue(args[1], 0),
                    start: floatValue(args[2], 0),
                    stop: floatValue(args[3], 1),
                };
                break;
            case "blur_detections":
            case "bd":
                transform.blurAreas = [{ left: 0, top: 0, width: 1, height: 1 }];
                transform.blurSigma = floatValue(args[0], 2) || undefined;
                break;
            case "draw_detections":
            case "dd":
                throw new ImgproxyError("draw_detections requires imgproxy Pro object detection", 422);
            case "crop_objects":
            case "c_obj":
                transform.gravity = { type: "obj" };
                break;
            case "colorize":
            case "col":
                transform.colorize = {
                    opacity: Math.min(1, Math.max(0, floatValue(args[0], 0))),
                    color: args[1] ?? "#000000",
                    keepAlpha: boolValue(args[2], false),
                };
                break;
            case "gradient":
            case "gr":
                transform.gradient = {
                    opacity: Math.min(1, Math.max(0, floatValue(args[0], 0))),
                    color: args[1] ?? "#000000",
                    direction: floatValue(args[2], 0),
                    start: floatValue(args[3], 0),
                    stop: floatValue(args[4], 1),
                };
                break;
            case "watermark":
            case "wm": {
                const opacity = floatValue(args[0], 1);
                transform.watermarkPosition = (args[1] ?? "ce") as GravityType;
                transform.watermarkOffsetX = floatValue(args[2], 0);
                transform.watermarkOffsetY = floatValue(args[3], 0);
                transform.watermarkScale = floatValue(args[4], 0) || undefined;
                transform.watermarkOpacity = Math.min(1, Math.max(0, opacity));
                break;
            }
            case "watermark_url":
            case "wmu":
                request.watermarkUrl = decodeBase64Url(args[0] ?? "");
                transform.watermarkPosition = transform.watermarkPosition ?? "ce";
                transform.watermarkOpacity = transform.watermarkOpacity ?? 1;
                break;
            case "watermark_text":
            case "wmt":
                transform.watermarkText = stripMarkup(decodeBase64Url(args[0] ?? ""));
                transform.watermarkPosition = transform.watermarkPosition ?? "ce";
                transform.watermarkFontSize = Math.max(
                    1,
                    intValue(args[2], transform.watermarkFontSize ?? 16),
                );
                transform.watermarkColor = args[3] ?? transform.watermarkColor ?? "#000000";
                transform.watermarkOpacity = transform.watermarkOpacity ?? 1;
                break;
            case "watermark_size":
            case "wms":
                transform.watermarkWidth = intValue(args[0], 0) || undefined;
                transform.watermarkHeight = intValue(args[1], 0) || undefined;
                break;
            case "watermark_rotate":
            case "wm_rot":
            case "wmr":
                transform.watermarkRotate = floatValue(args[0], 0) || undefined;
                break;
            case "watermark_shadow":
            case "wmsh":
                transform.watermarkShadow = floatValue(args[0], 0) || undefined;
                break;
            case "style":
            case "st":
                transform.svgStyle = decodeBase64Url(args[0] ?? "");
                break;
            case "strip_metadata":
            case "sm":
            case "keep_copyright":
            case "kcr":
            case "dpi":
            case "strip_color_profile":
            case "scp":
            case "preserve_hdr":
            case "ph":
            case "color_profile":
            case "cp":
            case "icc":
            case "enforce_thumbnail":
            case "eth":
                break;
            case "quality":
            case "q":
                transform.quality = Math.min(100, Math.max(1, intValue(args[0], config.quality)));
                break;
            case "format_quality":
            case "fq": {
                let index = 0;
                while (index < args.length) {
                    const equalsIndex = args[index]?.indexOf("=") ?? -1;
                    if (equalsIndex > 0) {
                        const format = normalizeFormat(args[index].slice(0, equalsIndex));
                        const quality = intValue(args[index].slice(equalsIndex + 1), config.quality);
                        if (format) {
                            transform.formatQuality = {
                                ...(transform.formatQuality ?? {}),
                                [format]: Math.min(100, Math.max(1, quality)),
                            };
                        }
                        index += 1;
                        continue;
                    }

                    const format = normalizeFormat(args[index]);
                    const quality = intValue(args[index + 1], config.quality);
                    if (format) {
                        transform.formatQuality = {
                            ...(transform.formatQuality ?? {}),
                            [format]: Math.min(100, Math.max(1, quality)),
                        };
                    }
                    index += 2;
                }
                break;
            }
            case "autoquality":
            case "aq":
                transform.autoQuality = {
                    method: args[0] ?? "size",
                    target: floatValue(args[1], 0),
                    min: floatValue(args[2], 10),
                    max: floatValue(args[3], 80),
                    allowedError: floatValue(args[4], 0.001),
                };
                break;
            case "max_bytes":
            case "mb":
                transform.maxBytes = Math.max(0, intValue(args[0], 0)) || undefined;
                break;
            case "jpeg_options":
            case "jpgo":
                transform.jpegOptions = {
                    progressive: boolValue(args[0], false),
                    noSubsample: boolValue(args[1], false),
                    trellisQuant: boolValue(args[2], false),
                    overshootDeringing: boolValue(args[3], false),
                    optimizeScans: boolValue(args[4], false),
                    quantTable: intValue(args[5], 0),
                };
                break;
            case "png_options":
            case "pngo":
                transform.pngOptions = {
                    interlaced: boolValue(args[0], false),
                    quantize: boolValue(args[1], true),
                    quantizationColors: intValue(args[2], 0) || undefined,
                };
                break;
            case "webp_options":
            case "webpo":
                transform.webpOptions = {
                    compression: intValue(args[0], 4),
                    smartSubsample: boolValue(args[1], false),
                    preset: args[2],
                };
                break;
            case "avif_options":
            case "avifo":
                transform.avifOptions = { subsample: args[0] };
                break;
            case "format":
            case "f":
            case "ext": {
                const format = args[0] ?? "";
                if (format === "best") {
                    request.bestFormat = true;
                    transform.bestFormat = true;
                } else {
                    const normalized = normalizeFormat(format);
                    if (!normalized) {
                        throw new ImgproxyError(`Unsupported image format: ${format}`, 422);
                    }
                    transform.format = normalized;
                }
                break;
            }
            case "page":
            case "pg":
                request.pdfPage = Math.max(1, intValue(args[0], 1));
                break;
            case "pages":
            case "pgs":
                if (intValue(args[0], 1) !== 1) {
                    throw new ImgproxyError("Animated and multi-page images are not supported", 422);
                }
                break;
            case "disable_animation":
            case "da":
                request.disableAnimation = boolValue(args[0], true);
                transform.disableAnimation = request.disableAnimation;
                break;
            case "fallback_image_url":
            case "fiu":
                request.fallbackImageUrl = decodeBase64Url(args[0] ?? "");
                break;
            case "skip_processing":
            case "skp":
                request.skipProcessing = args
                    .map((value) => normalizeFormat(value))
                    .filter((value): value is TargetFormat => Boolean(value));
                break;
            case "raw":
                request.raw = boolValue(args[0], true);
                break;
            case "cachebuster":
            case "cb":
                request.cachebuster = args[0];
                break;
            case "bypass_cache":
            case "bc":
            case "cache_tags":
            case "ct":
            case "c2pa":
                break;
            case "expires":
            case "exp":
                request.expires = intValue(args[0], 0);
                break;
            case "filename":
            case "fn": {
                const filename = args[0] ?? "";
                request.filename = boolValue(args[1], false) ? decodeBase64Url(filename) : filename;
                break;
            }
            case "return_attachment":
            case "att":
                request.returnAttachment = boolValue(args[0], false);
                break;
            case "hashsum":
            case "hs":
                request.hashsum = { type: (args[0] ?? "none").toLowerCase(), hash: args[1] ?? "" };
                break;
            case "max_src_resolution":
            case "msr":
                request.maxSrcResolution = Math.max(0, floatValue(args[0], 0));
                break;
            case "max_src_file_size":
            case "msfs":
                request.maxSrcFileSize = Math.max(0, intValue(args[0], 0));
                break;
            case "max_animation_frames":
            case "maf":
                request.maxAnimationFrames = Math.max(0, intValue(args[0], 0));
                break;
            case "max_animation_frame_resolution":
            case "mafr":
                request.maxAnimationFrameResolution = Math.max(0, floatValue(args[0], 0));
                break;
            case "max_result_dimension":
            case "mrd":
                request.maxResultDimension = Math.max(0, intValue(args[0], 0));
                break;
            case "video_thumbnail_second":
            case "vts":
                request.videoThumbnailSecond = Math.max(0, floatValue(args[0], 0));
                break;
            case "video_thumbnail_keyframes":
            case "vtk":
            case "video_thumbnail_tile":
            case "vtt":
            case "video_thumbnail_animation":
            case "vta":
                throw new ImgproxyError("Video thumbnail generation requires imgproxy Pro video support", 422);
            default:
                throw new ImgproxyError(`Unknown processing option: ${name}`, 400);
        }
    }

    if (!transform.format && source.extension) {
        const normalized = normalizeFormat(source.extension);
        if (normalized) transform.format = normalized;
    }

    if (transform.watermarkText || request.watermarkUrl || transform.watermarkImage) {
        transform.watermarkPosition = transform.watermarkPosition ?? "ce";
    }
    if (request.maxSrcResolution > 0) {
        transform.maxSourcePixels = Math.round(request.maxSrcResolution * 1_000_000);
    }
    transform.maxResultDimension = request.maxResultDimension;
    transform.disableAnimation = request.disableAnimation;
    transform.maxAnimationFrames = request.maxAnimationFrames;
    transform.maxAnimationFrameResolution = request.maxAnimationFrameResolution;

    return request;
}

export function createInfoRequest(source: SourceRef, config: ImgproxyConfig): ImgproxyRequest {
    const transform = defaultTransform(config);
    if (config.maxSrcResolution > 0) {
        transform.maxSourcePixels = Math.round(config.maxSrcResolution * 1_000_000);
    }
    return {
        transform,
        source,
        extension: source.extension,
        info: true,
        infoOptions: defaultInfoOptions(),
        bestFormat: false,
        returnAttachment: config.returnAttachment,
        raw: false,
        disableAnimation: false,
        skipProcessing: [],
        maxSrcResolution: config.maxSrcResolution,
        maxSrcFileSize: config.maxSrcFileSize,
        maxResultDimension: config.maxResultDimension,
        maxAnimationFrames: config.maxAnimationFrames,
        maxAnimationFrameResolution: config.maxAnimationFrameResolution,
        videoThumbnailSecond: undefined,
        pdfPage: undefined,
    };
}

function parseResizeType(value: string): TransformOptions["resizeType"] {
    if (!["fit", "fill", "fill-down", "force", "auto"].includes(value)) {
        throw new ImgproxyError(`Unknown resizing type: ${value}`, 400);
    }
    return value as TransformOptions["resizeType"];
}

export function parseInfoOptions(segments: string[], config: ImgproxyConfig): InfoOptions {
    const options = defaultInfoOptions();
    for (const segment of applyPresets(segments, config, false)) {
        const { name, args } = splitOption(segment, config.argsSeparator);
        const enabled = boolValue(args[0], true);
        switch (name) {
            case "size":
            case "s":
                options.size = enabled;
                break;
            case "format":
            case "f":
                options.format = enabled;
                break;
            case "dimensions":
            case "d":
                options.dimensions = enabled;
                break;
            case "exif":
                options.exif = enabled;
                break;
            case "iptc":
                options.iptc = enabled;
                break;
            case "xmp":
                options.xmp = enabled;
                break;
            case "video_meta":
            case "vm":
                if (enabled) {
                    throw new ImgproxyError("video_meta requires imgproxy Pro video support", 422);
                }
                options.videoMeta = enabled;
                break;
            case "detect_objects":
            case "do":
                if (enabled) {
                    throw new ImgproxyError("detect_objects requires imgproxy Pro object detection", 422);
                }
                options.detectObjects = false;
                break;
            case "classify":
            case "cl":
                if (enabled) {
                    throw new ImgproxyError("classify requires imgproxy Pro classification", 422);
                }
                options.classify = false;
                break;
            case "colorspace":
            case "cs":
                options.colorspace = enabled;
                break;
            case "dominant_colors":
            case "dc":
                options.dominantColors = enabled;
                break;
            case "blurhash":
            case "bh":
                if (enabled) {
                    throw new ImgproxyError("blurhash requires imgproxy Pro support", 422);
                }
                options.blurhash = enabled;
                break;
            default:
                throw new ImgproxyError(`Unknown info option: ${name}`, 400);
        }
    }
    return options;
}
