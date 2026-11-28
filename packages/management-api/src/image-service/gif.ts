import { Transformer } from "@napi-rs/image";
import { parseGIF, decompressFrames, type ParsedFrame } from "gifuct-js";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { toRgba } from "./effects";

export function decodeGif(input: Uint8Array): Transformer {
    const frame = decodeGifFrames(input, 1)[0];
    if (!frame) throw new Error("GIF contains no frames");
    return Transformer.fromRgbaPixels(frame.data, frame.width, frame.height);
}

export type AnimatedFrame = {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    delayMs: number;
};

export function decodeGifFrames(input: Uint8Array, maxFrames = 0, maxPixels = 50_000_000): AnimatedFrame[] {
    const buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
    const parsed = parseGIF(buffer);
    const frames = decompressFrames(parsed, true);
    if (frames.length === 0) {
        throw new Error("GIF contains no frames");
    }

    const width = parsed.lsd.width;
    const height = parsed.lsd.height;
    if (width <= 0 || height <= 0 || width * height > maxPixels) {
        throw new Error(`GIF frame resolution exceeds maximum allowed pixels (${maxPixels})`);
    }
    const canvas = new Uint8ClampedArray(width * height * 4);
    const output: AnimatedFrame[] = [];
    for (const frame of frames.slice(0, maxFrames > 0 ? maxFrames : frames.length)) {
        const previous = frame.disposalType === 3 ? canvas.slice() : undefined;
        drawFrame(canvas, frame, width, height);
        output.push({
            data: canvas.slice(),
            width,
            height,
            delayMs: Math.max(20, frame.delay || 100),
        });
        if (frame.disposalType === 2) {
            clearFrame(canvas, frame, width, height);
        } else if (frame.disposalType === 3 && previous) {
            canvas.set(previous);
        }
    }
    return output;
}

export function encodeGif(transformer: Transformer): Uint8Array {
    const image = toRgba(transformer);
    return encodeGifFrames([{ ...image, delayMs: 100 }]);
}

export function encodeGifFrames(frames: AnimatedFrame[]): Uint8Array {
    if (frames.length === 0) throw new Error("GIF contains no frames");
    const width = frames[0].width;
    const height = frames[0].height;
    const gif = GIFEncoder();
    frames.forEach((frame, index) => {
        if (frame.width !== width || frame.height !== height) {
            throw new Error("Animated GIF frames must have the same dimensions");
        }
        const framePalette = quantize(frame.data, 256);
        gif.writeFrame(applyPalette(frame.data, framePalette), width, height, {
            palette: framePalette,
            repeat: index === 0 ? 0 : undefined,
            delay: frame.delayMs,
            dispose: 1,
        });
    });
    gif.finish();
    return gif.bytes();
}

function drawFrame(canvas: Uint8ClampedArray, frame: ParsedFrame, width: number, height: number): void {
    const frameWidth = frame.dims.width;
    const frameHeight = frame.dims.height;
    for (let y = 0; y < frameHeight; y += 1) {
        for (let x = 0; x < frameWidth; x += 1) {
            const sourceIndex = (y * frameWidth + x) * 4;
            const targetX = frame.dims.left + x;
            const targetY = frame.dims.top + y;
            if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
            const targetIndex = (targetY * width + targetX) * 4;
            if (frame.patch[sourceIndex + 3] === 0) continue;
            canvas[targetIndex] = frame.patch[sourceIndex];
            canvas[targetIndex + 1] = frame.patch[sourceIndex + 1];
            canvas[targetIndex + 2] = frame.patch[sourceIndex + 2];
            canvas[targetIndex + 3] = frame.patch[sourceIndex + 3];
        }
    }
}

function clearFrame(canvas: Uint8ClampedArray, frame: ParsedFrame, width: number, height: number): void {
    for (let y = 0; y < frame.dims.height; y += 1) {
        for (let x = 0; x < frame.dims.width; x += 1) {
            const targetX = frame.dims.left + x;
            const targetY = frame.dims.top + y;
            if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
            canvas.fill(0, (targetY * width + targetX) * 4, (targetY * width + targetX + 1) * 4);
        }
    }
}
