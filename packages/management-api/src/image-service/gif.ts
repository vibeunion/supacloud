import { Transformer } from "@napi-rs/image";
import { parseGIF, decompressFrames } from "gifuct-js";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { toRgba } from "./effects";

export function decodeGif(input: Uint8Array): Transformer {
    const buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
    const parsed = parseGIF(buffer);
    const frames = decompressFrames(parsed, true);
    if (frames.length === 0) {
        throw new Error("GIF contains no frames");
    }

    const width = parsed.lsd.width;
    const height = parsed.lsd.height;
    const canvas = new Uint8ClampedArray(width * height * 4);
    const frame = frames[0];
    const frameWidth = frame.dims.width;
    const frameHeight = frame.dims.height;
    for (let y = 0; y < frameHeight; y += 1) {
        for (let x = 0; x < frameWidth; x += 1) {
            const sourceIndex = (y * frameWidth + x) * 4;
            const targetX = frame.dims.left + x;
            const targetY = frame.dims.top + y;
            if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
            const targetIndex = (targetY * width + targetX) * 4;
            canvas[targetIndex] = frame.patch[sourceIndex];
            canvas[targetIndex + 1] = frame.patch[sourceIndex + 1];
            canvas[targetIndex + 2] = frame.patch[sourceIndex + 2];
            canvas[targetIndex + 3] = frame.patch[sourceIndex + 3];
        }
    }
    return Transformer.fromRgbaPixels(canvas, width, height);
}

export function encodeGif(transformer: Transformer): Uint8Array {
    const image = toRgba(transformer);
    const palette = quantize(image.data, 256);
    const index = applyPalette(image.data, palette);
    const gif = GIFEncoder();
    gif.writeFrame(index, image.width, image.height, { palette, repeat: 0 });
    gif.finish();
    return gif.bytes();
}
