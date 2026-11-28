# SupaCloud Image Core

This crate is the native media boundary for the image service. It is a
library, not an HTTP server, so the existing Bun process keeps ownership of
imgproxy URL parsing, signatures, source access, policy, and deployment.

The default build contains the bounded raster pipeline only. Heavy capabilities
are explicit Cargo features and are intended to be enabled in a separate
native artifact:

The raster contract accepts and emits `jpeg`, `png`, `webp`, `avif`, `gif`,
`bmp`, `tiff`, and `ico`. BMP and TIFF are not pass-through-only formats:
they are decoded, resized, and transcoded like the other raster formats.

```text
pdf  -> pdfium-render adapter
onnx -> ort adapter
c2pa -> c2pa-rs adapter
icc  -> moxcms adapter
napi -> Node/Bun N-API exports
```

The first integration point is `capability_report()` and
`process_raster_buffer()` when built with `--features napi`. Keeping the
feature boundary explicit means the normal SupaCloud image binary does not
download or load PDFium, ONNX Runtime, C2PA, or color-management runtimes.
