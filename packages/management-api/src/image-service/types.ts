export type WatermarkAnchor = "start" | "center" | "end" | number;

export type TargetFormat =
    | "avif"
    | "webp"
    | "jpeg"
    | "png"
    | "gif"
    | "bmp"
    | "tiff"
    | "ico";

export type ResizeType = "fit" | "fill" | "fill-down" | "force" | "auto" | "smart";

export type GravityType =
    | "no"
    | "so"
    | "ea"
    | "we"
    | "noea"
    | "nowe"
    | "soea"
    | "sowe"
    | "ce"
    | "sm"
    | "fp"
    | "obj"
    | "objw"
    | "re"
    | "ch";

export type Gravity = {
    type: GravityType;
    x?: number;
    y?: number;
    classes?: string[];
    weights?: number[];
};

export type CropOptions = {
    width: number;
    height: number;
    gravity?: Gravity;
};

export type TrimOptions = {
    threshold: number;
    color?: string;
    equalHorizontal?: boolean;
    equalVertical?: boolean;
};

export type PaddingOptions = {
    top: number;
    right: number;
    bottom: number;
    left: number;
};

export type DuotoneOptions = {
    intensity: number;
    dark: string;
    light: string;
};

export type GradientOptions = {
    opacity: number;
    color: string;
    direction: number;
    start: number;
    stop: number;
};

export type BlurArea = {
    left: number;
    top: number;
    width: number;
    height: number;
};

export type AutoQualityOptions = {
    method: string;
    target: number;
    min: number;
    max: number;
    allowedError: number;
};

export type ImageWatermarkOptions = {
    position?: GravityType;
    offsetX?: number;
    offsetY?: number;
    scale?: number;
    opacity?: number;
    rotate?: number;
    shadow?: number;
    width?: number;
    height?: number;
};

export type TransformOptions = {
    width?: number;
    height?: number;
    fitIn: boolean;
    stretch: boolean;
    smart: boolean;
    flipHorizontal: boolean;
    flipVertical: boolean;
    format?: TargetFormat;
    quality: number;
    blurSigma?: number;
    sharpenSigma?: number;
    contrast?: number;
    brightness?: number;
    grayscale: boolean;
    invert: boolean;
    rotateDeg?: number;
    isMeta: boolean;
    watermarkText?: string;
    watermarkX: WatermarkAnchor;
    watermarkY: WatermarkAnchor;
    watermarkOpacity: number;
    watermarkColor: string;
    watermarkFontSize: number;
    watermarkImageWidth?: number;
    watermarkImageHeight?: number;
    resizeType?: ResizeType;
    resizeFilter?: "nearest" | "linear" | "cubic" | "lanczos2" | "lanczos3";
    enlarge?: boolean;
    extend?: boolean;
    extendAspectRatio?: boolean;
    extendGravity?: Gravity;
    gravity?: Gravity;
    crop?: CropOptions;
    cropAspectRatio?: number;
    objectsPosition?: Gravity;
    trim?: TrimOptions;
    padding?: PaddingOptions;
    background?: string;
    backgroundAlpha?: number;
    minWidth?: number;
    minHeight?: number;
    zoom?: number;
    dpr?: number;
    saturation?: number;
    gamma?: number;
    pixelateSize?: number;
    monochrome?: { intensity: number; color?: string };
    duotone?: DuotoneOptions;
    colorize?: { opacity: number; color: string; keepAlpha?: boolean };
    gradient?: GradientOptions;
    blurAreas?: BlurArea[];
    progressiveBlur?: { sigma: number; direction: number; start: number; stop: number };
    unsharpMasking?: { mode?: string; weight: number; divider: number };
    watermarkImage?: Uint8Array;
    watermarkPosition?: GravityType;
    watermarkOffsetX?: number;
    watermarkOffsetY?: number;
    watermarkScale?: number;
    watermarkRotate?: number;
    watermarkShadow?: number;
    watermarkWidth?: number;
    watermarkHeight?: number;
    autoRotate?: boolean;
    autoQuality?: AutoQualityOptions;
    maxBytes?: number;
    formatQuality?: Partial<Record<TargetFormat, number>>;
    jpegOptions?: {
        progressive?: boolean;
        noSubsample?: boolean;
        trellisQuant?: boolean;
        overshootDeringing?: boolean;
        optimizeScans?: boolean;
        quantTable?: number;
    };
    pngOptions?: {
        interlaced?: boolean;
        quantize?: boolean;
        quantizationColors?: number;
    };
    webpOptions?: {
        compression?: number;
        smartSubsample?: boolean;
        preset?: string;
    };
    avifOptions?: {
        subsample?: string;
    };
    svgStyle?: string;
    skipProcessing?: boolean;
    disableAnimation?: boolean;
    maxAnimationFrames?: number;
    maxAnimationFrameResolution?: number;
    videoThumbnailSecond?: number;
    bestFormat?: boolean;
    drawDetections?: boolean;
    maxSourcePixels?: number;
    maxResultDimension?: number;
};

export type ProcessedImage = {
    bytes: Uint8Array;
    contentType: string;
};
