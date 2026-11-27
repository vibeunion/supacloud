import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Transformer } from "@napi-rs/image";
import { processImage } from "../../src/image-service/engine";
import { parsePath } from "../../src/image-service/parser";

const repoRoot = join(import.meta.dir, "../../../..");
const jpegBytes = new Uint8Array(
  readFileSync(join(repoRoot, "packages/web-console/static/images/cabin-cedar.jpg")),
);

describe("image path parser", () => {
  test("parses fit-in geometry and filters", () => {
    const options = parsePath("/fit-in/400x300/filters:format(webp):quality(85)/");
    expect(options.width).toBe(400);
    expect(options.height).toBe(300);
    expect(options.fitIn).toBe(true);
    expect(options.format).toBe("webp");
    expect(options.quality).toBe(85);
  });

  test("parses smartcrop and effects", () => {
    const options = parsePath("/300x0/smart/filters:format(jpeg):quality(90):blur(2.5):grayscale():rotate(90)/");
    expect(options.width).toBe(300);
    expect(options.height).toBeUndefined();
    expect(options.smart).toBe(true);
    expect(options.format).toBe("jpeg");
    expect(options.blurSigma).toBe(2.5);
    expect(options.grayscale).toBe(true);
    expect(options.rotateDeg).toBe(90);
  });

  test("parses a percent-encoded base64url text watermark", () => {
    const encoded = Buffer.from("ACME", "utf8").toString("base64url");
    const options = parsePath(
      `/filters:format(png):text(b64%3A${encoded},center,bottom,sans%20bold%2020,white,100,,0,low,false,word)/`,
    );
    expect(options.watermarkText).toBe("ACME");
    expect(options.watermarkOpacity).toBe(1);
    expect(options.watermarkFontSize).toBe(20);
    expect(options.watermarkColor).toBe("#ffffff");
  });

  test("parses an image watermark", () => {
    const options = parsePath(
      "/filters:format(png):watermark(b64%3AaHR0cDovL2V4YW1wbGUuY29tL3dtLnBuZw,center,center,50,120,80)/",
    );
    expect(options.watermarkOpacity).toBe(0.5);
    expect(options.watermarkImageWidth).toBe(120);
    expect(options.watermarkImageHeight).toBe(80);
  });

  test("parses metadata mode", () => {
    expect(parsePath("/meta/").isMeta).toBe(true);
  });
});

describe("image engine", () => {
  test("encodes lossy WebP", () => {
    const output = processImage(jpegBytes, parsePath("/fit-in/400x0/filters:format(webp):quality(80)/"));
    expect(output.contentType).toBe("image/webp");
    expect(String.fromCharCode(...output.bytes.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...output.bytes.slice(8, 12))).toBe("WEBP");
    expect(output.bytes.length).toBeLessThan(400_000);
  });

  test("smartcrop returns the requested dimensions", () => {
    const output = processImage(
      jpegBytes,
      parsePath("/smart/400x400/filters:format(webp):quality(80)/"),
    );
    const metadata = new Transformer(output.bytes).metadataSync();
    expect(metadata.width).toBe(400);
    expect(metadata.height).toBe(400);
  });

  test("text watermark changes the output", () => {
    const plain = processImage(jpegBytes, parsePath("/fit-in/200x0/filters:format(webp):quality(80)/"));
    const encoded = Buffer.from("ACME", "utf8").toString("base64url");
    const watermarked = processImage(
      jpegBytes,
      parsePath(
        `/fit-in/200x0/filters:format(webp):quality(80):text(b64%3A${encoded},center,bottom,sans%20bold%2024,white,80,,0,low,false,word)/`,
      ),
    );
    expect(Buffer.compare(Buffer.from(plain.bytes), Buffer.from(watermarked.bytes))).not.toBe(0);
  });

  test("accepts AVIF input", () => {
    const avif = new Transformer(jpegBytes).resize(200).avifSync({ quality: 60, speed: 6 });
    const output = processImage(avif, parsePath("/fit-in/100x0/filters:format(webp):quality(80)/"));
    expect(output.contentType).toBe("image/webp");
    expect(output.bytes.length).toBeGreaterThan(0);
  });

  test("returns metadata JSON", () => {
    const output = processImage(jpegBytes, parsePath("/meta/"));
    expect(output.contentType).toBe("application/json");
    const metadata = JSON.parse(new TextDecoder().decode(output.bytes)) as {
      width: number;
      height: number;
      format: string;
      has_alpha: boolean;
    };
    expect(metadata.width).toBe(1400);
    expect(metadata.height).toBe(2100);
    expect(metadata.format).toBe("jpeg");
    expect(metadata.has_alpha).toBe(false);
  });
});
