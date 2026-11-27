export type WatermarkAnchor = "start" | "center" | "end" | number;

export type TargetFormat = "avif" | "webp" | "jpeg" | "png" | "bmp" | "tiff";

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
};

export type ProcessedImage = {
    bytes: Uint8Array;
    contentType: string;
};
