declare module "gifenc" {
    export type Palette = number[][];

    export type QuantizeOptions = {
        format?: "rgb565" | "rgb444" | "rgba4444";
        clearAlpha?: boolean;
        clearAlphaColor?: number;
        clearAlphaThreshold?: number;
        oneBitAlpha?: boolean | number;
    };

    export function quantize(
        rgba: Uint8Array | Uint8ClampedArray,
        maxColors: number,
        options?: QuantizeOptions,
    ): Palette;

    export function applyPalette(
        rgba: Uint8Array | Uint8ClampedArray,
        palette: Palette,
        format?: "rgb565" | "rgb444" | "rgba4444",
    ): Uint8Array;

    export type GifFrameOptions = {
        palette?: Palette;
        repeat?: number;
        delay?: number;
        transparent?: boolean;
        transparentIndex?: number;
        colorDepth?: number;
        dispose?: number;
        first?: boolean;
    };

    export type GifEncoder = {
        writeHeader(): void;
        writeFrame(index: Uint8Array, width: number, height: number, options?: GifFrameOptions): void;
        finish(): void;
        bytes(): Uint8Array;
        bytesView(): Uint8Array;
        reset(): void;
    };

    export function GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoder;
}
