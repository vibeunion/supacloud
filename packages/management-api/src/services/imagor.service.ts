import { config } from "../config";

export type ImageTransformQuery = Record<string, unknown>;

export type ImagorSource = {
    bytes: ArrayBuffer;
    contentType: string;
};

export type ImagorOperation = "standard" | "smartcrop" | "watermark" | "blur" | "info" | "thumbnail";

export type ImagorRequest = {
    path: string;
    outputFormat: string | null;
};

const IMAGOR_URL = config.imagorUrl.replace(/\/+$/, "");

function queryString(query: ImageTransformQuery, key: string): string | undefined {
    const value = query[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    return undefined;
}

function positiveInteger(query: ImageTransformQuery, key: string): number | undefined {
    const value = Number(queryString(query, key));
    if (!Number.isInteger(value) || value < 0 || value > 10000) return undefined;
    return value;
}

function boundedInteger(query: ImageTransformQuery, key: string, max: number): number | undefined {
    const value = Number(queryString(query, key));
    if (!Number.isInteger(value) || value < 0 || value > max) return undefined;
    return value;
}

function finiteNumber(query: ImageTransformQuery, key: string): string | undefined {
    const raw = queryString(query, key);
    if (raw === undefined || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? raw : undefined;
}

function enabled(query: ImageTransformQuery, key: string): boolean {
    const value = query[key];
    return value === true || value === 1 || value === "1" || value === "true";
}

function encoded(value: string): string {
    return encodeURIComponent(value);
}

function base64Url(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

function filter(name: string, args: string[] = []): string {
    return args.length > 0
        ? `${name}(${args.map(encoded).join(",")})`
        : `${name}()`;
}

function normalizeFormat(query: ImageTransformQuery): string | null {
    const value = queryString(query, "format")?.toLowerCase();
    if (!value || value === "origin") return null;
    if (value === "jpg") return "jpeg";
    if (!/^(avif|gif|heif|jpeg|png|tiff|webp)$/.test(value)) return "webp";
    return value;
}

function outputMimeType(format: string | null, sourceContentType?: string): string | undefined {
    if (!format) return sourceContentType;
    if (format === "jpeg") return "image/jpeg";
    if (format === "tiff") return "image/tiff";
    return `image/${format}`;
}

function gravityPosition(gravity: string | undefined): [string, string] {
    switch ((gravity || "center").toLowerCase()) {
        case "north":
        case "top":
        case "top-center":
            return ["center", "top"];
        case "south":
        case "bottom":
        case "bottom-center":
            return ["center", "bottom"];
        case "east":
        case "right":
        case "center-right":
            return ["right", "center"];
        case "west":
        case "left":
        case "center-left":
            return ["left", "center"];
        case "north-east":
        case "top-right":
            return ["right", "top"];
        case "north-west":
        case "top-left":
            return ["left", "top"];
        case "south-east":
        case "bottom-right":
            return ["right", "bottom"];
        case "south-west":
        case "bottom-left":
            return ["left", "bottom"];
        default:
            return ["center", "center"];
    }
}

function watermarkAlpha(query: ImageTransformQuery): string {
    const rawOpacity = Number(queryString(query, "opacity") ?? queryString(query, "wm_opacity") ?? "0.3");
    if (!Number.isFinite(rawOpacity)) return "30";
    const opacity = rawOpacity <= 1 ? rawOpacity * 100 : rawOpacity;
    return String(Math.min(100, Math.max(0, Math.round(opacity))));
}

function addStandardFilters(query: ImageTransformQuery, filters: string[], includeExport = true): void {
    const format = normalizeFormat(query);
    const requestedFormat = queryString(query, "format")?.toLowerCase();
    if (includeExport && requestedFormat !== "origin") {
        filters.push(filter("format", [format || "webp"]));
    }

    if (includeExport) {
        const quality = Number(queryString(query, "quality") ?? "80");
        if (Number.isFinite(quality)) {
            filters.push(filter("quality", [String(Math.min(100, Math.max(0, Math.round(quality))))]));
        }
    }

    if (enabled(query, "grayscale")) filters.push(filter("grayscale"));
    if (enabled(query, "invert")) filters.push(filter("invert"));
    if (enabled(query, "strip_metadata")) filters.push(filter("strip_metadata"));
    if (enabled(query, "strip_icc")) filters.push(filter("strip_icc"));
    if (enabled(query, "strip_exif")) filters.push(filter("strip_exif"));
    if (enabled(query, "upscale")) filters.push(filter("upscale"));
    if (enabled(query, "no_upscale")) filters.push(filter("no_upscale"));
    if (enabled(query, "lossless")) filters.push(filter("lossless"));
    if (enabled(query, "palette")) filters.push(filter("palette"));

    const bitdepth = positiveInteger(query, "bitdepth");
    if (bitdepth !== undefined) filters.push(filter("bitdepth", [String(bitdepth)]));

    const rotate = finiteNumber(query, "rotate");
    if (rotate !== undefined) filters.push(filter("rotate", [rotate]));

    const sharpen = finiteNumber(query, "sharpen");
    if (sharpen !== undefined) filters.push(filter("sharpen", [sharpen]));

    const pixelate = finiteNumber(query, "pixelate");
    if (pixelate !== undefined) filters.push(filter("pixelate", [pixelate]));

    const roundCorner = queryString(query, "round_corner");
    if (roundCorner !== undefined) {
        filters.push(filter("round_corner", roundCorner.split(",").map((value) => value.trim())));
    }

    const background = queryString(query, "background") || queryString(query, "background_color");
    if (background !== undefined) filters.push(filter("fill", [background]));

    const maxBytes = boundedInteger(query, "max_bytes", 64 * 1024 * 1024);
    if (maxBytes !== undefined) filters.push(filter("max_bytes", [String(maxBytes)]));

    const trim = enabled(query, "trim") || queryString(query, "trim") === "true";
    if (trim) {
        const side = queryString(query, "trim_side");
        const tolerance = positiveInteger(query, "trim_tolerance");
        const args = tolerance !== undefined ? [String(tolerance)] : [];
        if (side) args.push(side);
        filters.unshift(filter("trim", args));
    }

    const blur = queryString(query, "blur") || queryString(query, "sigma");
    if (blur !== undefined) filters.push(filter("blur", [blur]));

    const filterValues: Array<[string, string]> = [
        ["brightness", "brightness"],
        ["contrast", "contrast"],
        ["modulate", "modulate"],
        ["hue", "hue"],
        ["saturation", "saturation"],
        ["rgb", "rgb"],
        ["to_colorspace", "to_colorspace"],
        ["fallback_format", "fallback_format"],
        ["compression", "compression"],
        ["max_frames", "max_frames"],
        ["page", "page"],
        ["dpi", "dpi"],
        ["orient", "orient"],
        ["focal", "focal"],
        ["crop", "crop"],
        ["redact", "redact"],
        ["redact_oval", "redact_oval"],
        ["draw_detections", "draw_detections"],
    ];
    for (const [queryKey, filterName] of filterValues) {
        const value = queryString(query, queryKey);
        if (value !== undefined) filters.push(filter(filterName, value.split(",").map((item) => item.trim())));
    }

    if (enabled(query, "avgcolor")) filters.push(filter("avgcolor"));
    if (enabled(query, "thumbhash")) filters.push(filter("thumbhash"));
    const blurhash = queryString(query, "blurhash");
    if (blurhash !== undefined) filters.push(filter("blurhash", blurhash.split(",").map((item) => item.trim())));
}

function addTextOrImageOverlay(query: ImageTransformQuery, filters: string[]): void {
    const text = queryString(query, "text")
        || queryString(query, "watermark")
        || queryString(query, "wm")
        || queryString(query, "wm_text");
    const image = queryString(query, "image") || queryString(query, "wm_image");
    const [gravityX, gravityY] = gravityPosition(queryString(query, "gravity") || queryString(query, "wm_gravity"));
    const x = queryString(query, "text_x") || queryString(query, "wm_dx") || gravityX;
    const y = queryString(query, "text_y") || queryString(query, "wm_dy") || gravityY;

    if (text !== undefined) {
        const font = (queryString(query, "font") || "sans bold 14").replace(/\s+/g, "-");
        const color = queryString(query, "text_color") || "white";
        filters.push(filter("text", [
            `b64:${base64Url(text)}`,
            queryString(query, "text_x") || x,
            queryString(query, "text_y") || y,
            font,
            color,
            watermarkAlpha(query),
            "",
            queryString(query, "text_width") || "0",
            queryString(query, "text_align") || "low",
            queryString(query, "text_justify") || "false",
            queryString(query, "text_wrap") || "word",
        ]));
    }

    if (image !== undefined && /^https?:\/\//i.test(image)) {
        filters.push(filter("watermark", [
            `b64:${base64Url(image)}`,
            queryString(query, "wm_x") || x,
            queryString(query, "wm_y") || y,
            watermarkAlpha(query),
            queryString(query, "wm_width") || "none",
            queryString(query, "wm_height") || "none",
        ]));
    }
}

function normalizeDimensions(query: ImageTransformQuery, operation: ImagorOperation): [number | undefined, number | undefined] {
    const defaultSize = operation === "smartcrop" ? 300 : operation === "thumbnail" ? 150 : undefined;
    return [
        positiveInteger(query, "width") ?? defaultSize,
        positiveInteger(query, "height"),
    ];
}

export function buildImagorRequest(
    query: ImageTransformQuery,
    operation: ImagorOperation = "standard",
): ImagorRequest {
    const parts: string[] = [];
    if (operation === "info") parts.push("meta");

    const [width, height] = normalizeDimensions(query, operation);
    const resize = queryString(query, "resize")?.toLowerCase() || (operation === "thumbnail" ? "contain" : "cover");
    const fitIn = enabled(query, "fit_in") || resize === "contain" || resize === "embed";
    const stretch = resize === "fill" || enabled(query, "stretch");
    const smart = enabled(query, "smartcrop") || enabled(query, "smart") || resize === "smartcrop";
    const flipHorizontal = queryString(query, "flip") === "horizontal" || queryString(query, "flip") === "both" || enabled(query, "flip_h");
    const flipVertical = queryString(query, "flip") === "vertical" || queryString(query, "flip") === "both" || enabled(query, "flip_v");

    if (enabled(query, "adaptive_full_fit_in")) parts.push("adaptive-full-fit-in");
    else if (enabled(query, "adaptive_fit_in")) parts.push("adaptive-fit-in");
    else if (enabled(query, "full_fit_in")) parts.push("full-fit-in");
    else if (fitIn) parts.push("fit-in");
    else if (stretch) parts.push("stretch");

    if (width !== undefined || height !== undefined) {
        const widthPart = width === undefined ? "0" : `${flipHorizontal ? "-" : ""}${width}`;
        const heightPart = height === undefined ? "0" : `${flipVertical ? "-" : ""}${height}`;
        parts.push(`${widthPart}x${heightPart}`);
    }

    const padding = queryString(query, "padding");
    if (padding) {
        const paddingValues = padding.split(",").map((value) => value.trim());
        const normalizedPadding = paddingValues.length === 2
            ? `${paddingValues[0]}x${paddingValues[1]}`
            : paddingValues.length === 4
                ? `${paddingValues[0]}x${paddingValues[1]}:${paddingValues[2]}x${paddingValues[3]}`
                : padding;
        if (/^\d+x\d+(?::\d+x\d+)?$/.test(normalizedPadding)) {
            if (width === undefined && height === undefined) parts.push("0x0");
            parts.push(normalizedPadding);
        }
    }

    const horizontal = queryString(query, "align") || queryString(query, "gravity_x");
    const vertical = queryString(query, "valign") || queryString(query, "gravity_y");
    if (horizontal && /^(left|right|center)$/.test(horizontal)) parts.push(horizontal);
    if (vertical && /^(top|bottom|middle|center)$/.test(vertical)) parts.push(vertical === "center" ? "middle" : vertical);
    if (smart) parts.push("smart");

    const filters: string[] = [];
    addStandardFilters(query, filters, operation !== "info");
    if (operation === "watermark" || queryString(query, "text") || queryString(query, "watermark") || queryString(query, "image") || queryString(query, "wm_image")) {
        addTextOrImageOverlay(query, filters);
    }

    const filterSegment = filters.length > 0 ? `filters:${filters.join(":")}` : "";
    if (filterSegment) parts.push(filterSegment);
    if (parts.length === 0 && operation !== "info") parts.push("filters:format(webp):quality(80)");

    const outputFormat = operation === "info" ? null : normalizeFormat(query) || "webp";
    return {
        path: `/${parts.join("/")}/`,
        outputFormat,
    };
}

export async function runImagorWithRequest(
    query: ImageTransformQuery,
    source: ImagorSource,
    operation: ImagorOperation = "standard",
): Promise<{ request: ImagorRequest; response: Response }> {
    const request = buildImagorRequest(query, operation);
    const response = await fetch(`${IMAGOR_URL}${request.path}`, {
        method: "POST",
        headers: { "Content-Type": source.contentType },
        body: source.bytes,
    });
    return { request, response };
}

export async function runImagor(
    query: ImageTransformQuery,
    source: ImagorSource,
    operation: ImagorOperation = "standard",
): Promise<Response> {
    return (await runImagorWithRequest(query, source, operation)).response;
}

export async function checkImagorHealth(): Promise<Response> {
    return await fetch(`${IMAGOR_URL}/healthcheck`);
}

export function imagorOutputContentType(
    response: Response,
    request: ImagorRequest,
    sourceContentType?: string,
): string | undefined {
    return response.headers.get("Content-Type")
        || outputMimeType(request.outputFormat, sourceContentType);
}
