import { readFileSync } from "node:fs";
import { Transformer } from "@napi-rs/image";
import { toRgba } from "../effects";
import type { ImgproxyConfig } from "./config";
import { ImgproxyError } from "./errors";

export type ObjectDetection = {
    x: number;
    y: number;
    width: number;
    height: number;
    score: number;
    class_id: number;
    label?: string;
};

export type Classification = {
    class_id: number;
    score: number;
    label?: string;
};

export async function withOnnxTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new ImgproxyError("ONNX inference timed out", 422)),
                    timeoutMs,
                );
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

type NativeOnnxModule = {
    onnxDetectBuffer?: (
        input: Uint8Array,
        modelPath: string,
        inputWidth?: number,
        inputHeight?: number,
        threads?: number,
        confidenceThreshold?: number,
    ) => string;
    onnxClassifyBuffer?: (
        input: Uint8Array,
        modelPath: string,
        inputWidth?: number,
        inputHeight?: number,
        threads?: number,
    ) => string;
};

let nativeModulePromise: Promise<NativeOnnxModule> | undefined;

function requireConfigured(config: ImgproxyConfig, modelPath: string, capability: string): void {
    if (!config.onnxEnabled) {
        throw new ImgproxyError(`ONNX ${capability} is disabled; set IMGPROXY_ONNX_ENABLED=true`, 422);
    }
    if (!modelPath) {
        throw new ImgproxyError(`ONNX ${capability} model is not configured`, 422);
    }
}

async function nativeModule(config: ImgproxyConfig): Promise<NativeOnnxModule> {
    if (!nativeModulePromise) {
        nativeModulePromise = import(config.onnxNativeModule)
            .then((module) => module as NativeOnnxModule)
            .catch((error) => {
                nativeModulePromise = undefined;
                throw new ImgproxyError(`ONNX native adapter is unavailable: ${String(error)}`, 422);
            });
    }
    return nativeModulePromise;
}

function labels(config: ImgproxyConfig): string[] {
    if (!config.onnxLabelsPath) return [];
    try {
        return readFileSync(config.onnxLabelsPath, "utf8")
            .split(/\r?\n/)
            .map((label) => label.trim())
            .filter(Boolean);
    } catch (error) {
        throw new ImgproxyError(`ONNX labels cannot be read: ${String(error)}`, 422);
    }
}

function labelResults<T extends { class_id: number }>(items: T[], values: string[]): T[] {
    return items.map((item) => {
        const label = values[item.class_id];
        return label === undefined ? item : { ...item, label };
    });
}

export async function detectObjects(
    input: Uint8Array,
    config: ImgproxyConfig,
): Promise<ObjectDetection[]> {
    requireConfigured(config, config.onnxDetectionModel, "object detection");
    const runtime = await nativeModule(config);
    if (typeof runtime.onnxDetectBuffer !== "function") {
        throw new ImgproxyError("ONNX native adapter does not expose object detection", 422);
    }
    try {
        const result = runtime.onnxDetectBuffer(
            input,
            config.onnxDetectionModel,
            config.onnxDetectionInputWidth,
            config.onnxDetectionInputHeight,
            config.onnxThreads,
            config.onnxConfidenceThreshold,
        );
        return labelResults(JSON.parse(result) as ObjectDetection[], labels(config));
    } catch (error) {
        if (error instanceof ImgproxyError) throw error;
        throw new ImgproxyError(`ONNX object detection failed: ${String(error)}`, 422);
    }
}

export async function classifyImage(
    input: Uint8Array,
    config: ImgproxyConfig,
): Promise<Classification[]> {
    requireConfigured(config, config.onnxClassificationModel, "classification");
    const runtime = await nativeModule(config);
    if (typeof runtime.onnxClassifyBuffer !== "function") {
        throw new ImgproxyError("ONNX native adapter does not expose classification", 422);
    }
    try {
        const result = runtime.onnxClassifyBuffer(
            input,
            config.onnxClassificationModel,
            config.onnxClassificationInputWidth,
            config.onnxClassificationInputHeight,
            config.onnxThreads,
        );
        return labelResults(JSON.parse(result) as Classification[], labels(config));
    } catch (error) {
        if (error instanceof ImgproxyError) throw error;
        throw new ImgproxyError(`ONNX classification failed: ${String(error)}`, 422);
    }
}

export function drawDetectionBoxes(
    transformer: Transformer,
    detections: readonly ObjectDetection[],
): Transformer {
    const image = toRgba(transformer);
    const pixels = image.data.slice();
    const width = image.width;
    const height = image.height;
    for (const detection of detections) {
        const left = Math.max(0, Math.min(width - 1, Math.round(detection.x)));
        const top = Math.max(0, Math.min(height - 1, Math.round(detection.y)));
        const right = Math.max(left, Math.min(width - 1, Math.round(detection.x + detection.width)));
        const bottom = Math.max(top, Math.min(height - 1, Math.round(detection.y + detection.height)));
        for (let x = left; x <= right; x += 1) {
            paintPixel(pixels, width, x, top);
            paintPixel(pixels, width, x, bottom);
        }
        for (let y = top; y <= bottom; y += 1) {
            paintPixel(pixels, width, left, y);
            paintPixel(pixels, width, right, y);
        }
    }
    return Transformer.fromRgbaPixels(pixels, width, height);
}

function paintPixel(pixels: Uint8ClampedArray, width: number, x: number, y: number): void {
    const offset = (y * width + x) * 4;
    pixels[offset] = 255;
    pixels[offset + 1] = 32;
    pixels[offset + 2] = 32;
    pixels[offset + 3] = 255;
}
