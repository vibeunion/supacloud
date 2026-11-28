import { readFileSync } from "node:fs";

export class ImgproxyConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ImgproxyConfigError";
    }
}

export type ImgproxyConfig = {
    keys: Uint8Array[];
    salts: Uint8Array[];
    signatureSize: number;
    trustedSignatures: Set<string>;
    allowedSources: string[];
    allowLoopback: boolean;
    allowLinkLocal: boolean;
    allowPrivate: boolean;
    localFilesystemRoot: string;
    sourceUrlEncryptionKey?: Uint8Array;
    presets: Map<string, string>;
    onlyPresets: boolean;
    baseUrl: string;
    quality: number;
    formatQuality: Map<string, number>;
    maxSrcResolution: number;
    maxSrcFileSize: number;
    maxResultDimension: number;
    maxAnimationFrames: number;
    maxAnimationFrameResolution: number;
    autoRotate: boolean;
    returnAttachment: boolean;
    secret: string;
    allowOrigin: string;
    timeoutMs: number;
    cacheControl: string;
    argsSeparator: string;
    skipProcessingFormats: Set<string>;
    stripMetadata: boolean;
    stripColorProfile: boolean;
    resultCacheDir: string;
    resultCacheTtlSeconds: number;
    resultCacheMaxBytes: number;
    resultCacheMaxEntries: number;
    s3Endpoint: string;
    s3Region: string;
    s3AccessKeyId: string;
    s3SecretAccessKey: string;
    s3SessionToken: string;
    s3VirtualHostStyle: boolean;
    gcsEndpoint: string;
    gcsToken: string;
    azureEndpoint: string;
    azureSasToken: string;
    azureBearerToken: string;
    swiftEndpoint: string;
    swiftToken: string;
    ffmpegPath: string;
    pdfRendererPath: string;
    mediaProcessTimeoutMs: number;
    onnxEnabled: boolean;
    onnxNativeModule: string;
    onnxDetectionModel: string;
    onnxClassificationModel: string;
    onnxLabelsPath: string;
    onnxThreads: number;
    onnxTimeoutMs: number;
    onnxConfidenceThreshold: number;
    onnxDetectionInputWidth: number;
    onnxDetectionInputHeight: number;
    onnxClassificationInputWidth: number;
    onnxClassificationInputHeight: number;
};

function env(name: string, fallback = ""): string {
    const value = process.env[name];
    return value === undefined ? fallback : value;
}

function boolEnv(name: string, fallback: boolean): boolean {
    const value = env(name).trim().toLowerCase();
    if (!value) return fallback;
    return value === "1" || value === "t" || value === "true" || value === "yes" || value === "on";
}

function intEnv(name: string, fallback: number): number {
    const value = Number.parseInt(env(name), 10);
    return Number.isInteger(value) ? value : fallback;
}

function floatEnv(name: string, fallback: number): number {
    const value = Number.parseFloat(env(name));
    return Number.isFinite(value) ? value : fallback;
}

function parseHex(name: string, value: string): Uint8Array | undefined {
    const normalized = value.trim();
    if (!normalized) return undefined;
    if (normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
        throw new ImgproxyConfigError(`${name} must be hex-encoded`);
    }
    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

function parseHexList(name: string, value: string): Uint8Array[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const parsed = parseHex(name, entry);
            if (!parsed) throw new ImgproxyConfigError(`${name} contains an empty value`);
            return parsed;
        });
}

function parsePresets(config: ImgproxyConfig): void {
    const separator = env("IMGPROXY_PRESETS_SEPARATOR", ",");
    const inline = env("IMGPROXY_PRESETS", "");
    const path = env("IMGPROXY_PRESETS_PATH", "");
    const definitions: string[] = [];

    if (inline) {
        definitions.push(...inline.split(separator).map((entry) => entry.trim()).filter(Boolean));
    }
    if (path) {
        const content = readFileSync(path, "utf8");
        definitions.push(...content.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry && !entry.startsWith("#")));
    }

    for (const definition of definitions) {
        const separatorIndex = definition.indexOf("=");
        if (separatorIndex <= 0) continue;
        const name = definition.slice(0, separatorIndex).trim();
        const options = definition.slice(separatorIndex + 1).trim();
        if (name) config.presets.set(name, options);
    }
}

function parseFormatQuality(value: string): Map<string, number> {
    const result = new Map<string, number>();
    for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
        const [format, quality] = entry.split("=").map((item) => item.trim());
        const parsed = Number.parseInt(quality ?? "", 10);
        if (format && Number.isInteger(parsed)) {
            result.set(format.toLowerCase(), Math.min(100, Math.max(1, parsed)));
        }
    }
    return result;
}

let cached: ImgproxyConfig | undefined;

export function getImgproxyConfig(): ImgproxyConfig {
    if (cached) return cached;

    const keys = parseHexList("IMGPROXY_KEY", env("IMGPROXY_KEY", ""));
    const salts = parseHexList("IMGPROXY_SALT", env("IMGPROXY_SALT", ""));
    if (keys.length !== salts.length) {
        throw new ImgproxyConfigError("IMGPROXY_KEY and IMGPROXY_SALT must contain the same number of values");
    }
    if (keys.length > 0 && keys.some((key) => key.byteLength === 0)) {
        throw new ImgproxyConfigError("IMGPROXY_KEY contains an empty value");
    }

    const encryptionKey = parseHex("IMGPROXY_SOURCE_URL_ENCRYPTION_KEY", env("IMGPROXY_SOURCE_URL_ENCRYPTION_KEY", ""));
    if (encryptionKey && ![16, 24, 32].includes(encryptionKey.byteLength)) {
        throw new ImgproxyConfigError("IMGPROXY_SOURCE_URL_ENCRYPTION_KEY must be 16, 24, or 32 bytes");
    }

    const config: ImgproxyConfig = {
        keys,
        salts,
        signatureSize: Math.min(32, Math.max(1, intEnv("IMGPROXY_SIGNATURE_SIZE", 32))),
        trustedSignatures: new Set(env("IMGPROXY_TRUSTED_SIGNATURES").split(",").map((item) => item.trim()).filter(Boolean)),
        allowedSources: env("IMGPROXY_ALLOWED_SOURCES").split(",").map((item) => item.trim()).filter(Boolean),
        allowLoopback: boolEnv("IMGPROXY_ALLOW_LOOPBACK_SOURCE_ADDRESSES", false),
        allowLinkLocal: boolEnv("IMGPROXY_ALLOW_LINK_LOCAL_SOURCE_ADDRESSES", false),
        allowPrivate: boolEnv("IMGPROXY_ALLOW_PRIVATE_SOURCE_ADDRESSES", true),
        localFilesystemRoot: env("IMGPROXY_LOCAL_FILESYSTEM_ROOT", "").replace(/\/+$/, ""),
        sourceUrlEncryptionKey: encryptionKey,
        presets: new Map(),
        onlyPresets: boolEnv("IMGPROXY_ONLY_PRESETS", false),
        baseUrl: env("IMGPROXY_BASE_URL", "").replace(/\/+$/, ""),
        quality: Math.min(100, Math.max(1, intEnv("IMGPROXY_QUALITY", 80))),
        formatQuality: parseFormatQuality(env("IMGPROXY_FORMAT_QUALITY", "")),
        maxSrcResolution: Math.max(0, floatEnv("IMGPROXY_MAX_SRC_RESOLUTION", 0)),
        maxSrcFileSize: Math.max(0, intEnv("IMGPROXY_MAX_SRC_FILE_SIZE", 0)),
        maxResultDimension: Math.max(0, intEnv("IMGPROXY_MAX_RESULT_DIMENSION", 0)),
        maxAnimationFrames: Math.max(0, intEnv("IMGPROXY_MAX_ANIMATION_FRAMES", 0)),
        maxAnimationFrameResolution: Math.max(0, floatEnv("IMGPROXY_MAX_ANIMATION_FRAME_RESOLUTION", 0)),
        autoRotate: boolEnv("IMGPROXY_AUTO_ROTATE", true),
        returnAttachment: boolEnv("IMGPROXY_RETURN_ATTACHMENT", false),
        secret: env("IMGPROXY_SECRET", ""),
        allowOrigin: env("IMGPROXY_ALLOW_ORIGIN", ""),
        timeoutMs: Math.max(1, intEnv("IMGPROXY_TIMEOUT", 10)) * 1000,
        cacheControl: env("IMGPROXY_CACHE_CONTROL", "public, max-age=3600, stale-while-revalidate=86400"),
        argsSeparator: env("IMGPROXY_ARGUMENTS_SEPARATOR", ":"),
        skipProcessingFormats: new Set(env("IMGPROXY_SKIP_PROCESSING_FORMATS").split(",").map((item) => item.trim()).filter(Boolean)),
        stripMetadata: boolEnv("IMGPROXY_STRIP_METADATA", true),
        stripColorProfile: boolEnv("IMGPROXY_STRIP_COLOR_PROFILE", true),
        resultCacheDir: env("IMGPROXY_RESULT_CACHE_DIR", ""),
        resultCacheTtlSeconds: Math.max(0, intEnv("IMGPROXY_RESULT_CACHE_TTL", 3600)),
        resultCacheMaxBytes: Math.max(0, intEnv("IMGPROXY_RESULT_CACHE_MAX_BYTES", 128 * 1024 * 1024)),
        resultCacheMaxEntries: Math.max(0, intEnv("IMGPROXY_RESULT_CACHE_MAX_ENTRIES", 1024)),
        s3Endpoint: env("IMGPROXY_S3_ENDPOINT", "https://s3.amazonaws.com"),
        s3Region: env("IMGPROXY_S3_REGION", "us-east-1"),
        s3AccessKeyId: env("IMGPROXY_S3_ACCESS_KEY_ID", env("AWS_ACCESS_KEY_ID")),
        s3SecretAccessKey: env("IMGPROXY_S3_SECRET_ACCESS_KEY", env("AWS_SECRET_ACCESS_KEY")),
        s3SessionToken: env("IMGPROXY_S3_SESSION_TOKEN", env("AWS_SESSION_TOKEN")),
        s3VirtualHostStyle: boolEnv("IMGPROXY_S3_VIRTUAL_HOST_STYLE", false),
        gcsEndpoint: env("IMGPROXY_GCS_ENDPOINT", "https://storage.googleapis.com"),
        gcsToken: env("IMGPROXY_GCS_TOKEN", env("GOOGLE_ACCESS_TOKEN")),
        azureEndpoint: env("IMGPROXY_AZURE_ENDPOINT", ""),
        azureSasToken: env("IMGPROXY_AZURE_SAS", ""),
        azureBearerToken: env("IMGPROXY_AZURE_BEARER_TOKEN", ""),
        swiftEndpoint: env("IMGPROXY_SWIFT_ENDPOINT", ""),
        swiftToken: env("IMGPROXY_SWIFT_TOKEN", ""),
        ffmpegPath: env("IMGPROXY_FFMPEG_PATH", "ffmpeg"),
        pdfRendererPath: env("IMGPROXY_PDF_RENDERER_PATH", "pdftocairo"),
        mediaProcessTimeoutMs: Math.max(1, intEnv("IMGPROXY_MEDIA_PROCESS_TIMEOUT", 30)) * 1000,
        onnxEnabled: boolEnv("IMGPROXY_ONNX_ENABLED", false),
        onnxNativeModule: env("IMGPROXY_ONNX_NATIVE_MODULE", "supacloud-image-core"),
        onnxDetectionModel: env("IMGPROXY_ONNX_DETECTION_MODEL", ""),
        onnxClassificationModel: env("IMGPROXY_ONNX_CLASSIFICATION_MODEL", ""),
        onnxLabelsPath: env("IMGPROXY_ONNX_LABELS", ""),
        onnxThreads: Math.min(32, Math.max(1, intEnv("IMGPROXY_ONNX_THREADS", 1))),
        onnxTimeoutMs: Math.max(1, intEnv("IMGPROXY_ONNX_TIMEOUT", 5)) * 1000,
        onnxConfidenceThreshold: Math.min(1, Math.max(0, floatEnv("IMGPROXY_ONNX_CONFIDENCE", 0.25))),
        onnxDetectionInputWidth: Math.max(1, intEnv("IMGPROXY_ONNX_DETECTION_INPUT_WIDTH", 640)),
        onnxDetectionInputHeight: Math.max(1, intEnv("IMGPROXY_ONNX_DETECTION_INPUT_HEIGHT", 640)),
        onnxClassificationInputWidth: Math.max(1, intEnv("IMGPROXY_ONNX_CLASSIFICATION_INPUT_WIDTH", 224)),
        onnxClassificationInputHeight: Math.max(1, intEnv("IMGPROXY_ONNX_CLASSIFICATION_INPUT_HEIGHT", 224)),
    };

    parsePresets(config);
    cached = config;
    return config;
}

export function resetImgproxyConfigCache(): void {
    cached = undefined;
}
