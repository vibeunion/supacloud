import { describe, expect, test } from "bun:test";
import {
    assertSupportedImageTransform,
    buildImageTransformRequest,
    ImageTransformRequestError,
} from "../../src/services/image-transform.service";

describe("image transform request", () => {
    test("builds a fit-in thumbnail path", () => {
        const request = buildImageTransformRequest({ width: 64, format: "png", quality: 70 }, "thumbnail");
        expect(request.path).toBe("/fit-in/64x0/filters:format(png):quality(70)/");
        expect(request.outputFormat).toBe("png");
    });

    test("smartcrop adds the smart segment", () => {
        const request = buildImageTransformRequest({ width: 300, height: 300 }, "smartcrop");
        expect(request.path).toContain("/smart/");
    });

    test("watermark encodes text as base64url", () => {
        const request = buildImageTransformRequest({ text: "ACME" }, "watermark");
        const path = decodeURIComponent(request.path);
        expect(path).toContain("text(b64:");
        expect(path).toContain(Buffer.from("ACME").toString("base64url"));
    });

    test("rejects unsupported parameters", () => {
        expect(() => assertSupportedImageTransform({ trim: "true" })).toThrow(ImageTransformRequestError);
        expect(() => assertSupportedImageTransform({ format: "origin" })).toThrow(ImageTransformRequestError);
    });

    test("rejects gif output that the native engine cannot encode", () => {
        expect(() => buildImageTransformRequest({ format: "gif" }))
            .toThrow(/unsupported image format: gif/i);
    });

    test("rejects watermark parameters on a non-watermark operation", () => {
        expect(() => buildImageTransformRequest({ text: "ACME" }, "standard"))
            .toThrow(/watermark transform operation/i);
    });

    test("rejects disallowed watermark origins", () => {
        expect(() => assertSupportedImageTransform({ image: "https://example.com/wm.png" }))
            .toThrow(/not allowed/i);
    });
});
