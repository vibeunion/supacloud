//! Rust media core used by the optional native acceleration path.
//!
//! The default build deliberately contains only the raster pipeline. Heavy
//! media runtimes are feature-gated so the Bun service remains a single-file
//! deployment by default:
//! `pdf`, `onnx`, `c2pa`, `icc`, and `napi`.

use image::codecs::avif::AvifEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageEncoder, ImageFormat, ImageReader};
use serde::Serialize;
use std::io::Cursor;

#[cfg(feature = "onnx")]
pub mod onnx;

pub const MAX_IMAGE_WIDTH: u32 = 10_000;
pub const MAX_IMAGE_HEIGHT: u32 = 10_000;
pub const MAX_IMAGE_PIXELS: u64 = 50_000_000;
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ImageCoreError {
    #[error("image payload exceeds {0} bytes")]
    PayloadTooLarge(usize),
    #[error("image decode failed: {0}")]
    Decode(String),
    #[error("image dimensions {0}x{1} exceed the configured limit")]
    DimensionsTooLarge(u32, u32),
    #[error("image encode failed: {0}")]
    Encode(String),
    #[error("unsupported output format: {0}")]
    UnsupportedFormat(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct ImageCoreCapabilities {
    pub raster: bool,
    pub napi: bool,
    pub pdf: bool,
    pub onnx: bool,
    pub c2pa: bool,
    pub icc: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RasterOptions {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub quality: u8,
}

pub fn capabilities() -> ImageCoreCapabilities {
    ImageCoreCapabilities {
        raster: true,
        napi: cfg!(feature = "napi"),
        pdf: cfg!(feature = "pdf"),
        onnx: cfg!(feature = "onnx"),
        c2pa: cfg!(feature = "c2pa"),
        icc: cfg!(feature = "icc"),
    }
}

pub fn process_raster(
    input: &[u8],
    format: &str,
    options: RasterOptions,
) -> Result<Vec<u8>, ImageCoreError> {
    if input.len() > MAX_PAYLOAD_BYTES {
        return Err(ImageCoreError::PayloadTooLarge(MAX_PAYLOAD_BYTES));
    }
    let reader = ImageReader::new(Cursor::new(input))
        .with_guessed_format()
        .map_err(|error| ImageCoreError::Decode(error.to_string()))?;
    let image = reader
        .decode()
        .map_err(|error| ImageCoreError::Decode(error.to_string()))?;
    validate_dimensions(&image)?;
    let transformed = resize(image, options.width, options.height);
    encode(&transformed, format, options.quality)
}

fn validate_dimensions(image: &DynamicImage) -> Result<(), ImageCoreError> {
    let (width, height) = image.dimensions();
    if width > MAX_IMAGE_WIDTH
        || height > MAX_IMAGE_HEIGHT
        || (width as u64) * (height as u64) > MAX_IMAGE_PIXELS
    {
        return Err(ImageCoreError::DimensionsTooLarge(width, height));
    }
    Ok(())
}

fn resize(image: DynamicImage, width: Option<u32>, height: Option<u32>) -> DynamicImage {
    match (
        width.filter(|value| *value > 0),
        height.filter(|value| *value > 0),
    ) {
        (Some(width), Some(height)) => image.resize_to_fill(width, height, FilterType::Lanczos3),
        (Some(width), None) => image.resize(width, u32::MAX, FilterType::Lanczos3),
        (None, Some(height)) => image.resize(u32::MAX, height, FilterType::Lanczos3),
        (None, None) => image,
    }
}

fn encode(image: &DynamicImage, format: &str, quality: u8) -> Result<Vec<u8>, ImageCoreError> {
    let normalized = format.to_ascii_lowercase();
    let mut output = Cursor::new(Vec::new());
    match normalized.as_str() {
        "jpg" | "jpeg" => JpegEncoder::new_with_quality(&mut output, quality.clamp(1, 100))
            .write_image(
                image.to_rgb8().as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgb8,
            ),
        "avif" => AvifEncoder::new_with_speed_quality(&mut output, 6, quality.clamp(1, 100))
            .write_image(
                image.to_rgba8().as_raw(),
                image.width(),
                image.height(),
                image::ExtendedColorType::Rgba8,
            ),
        "png" => image.write_to(&mut output, ImageFormat::Png),
        "webp" => image.write_to(&mut output, ImageFormat::WebP),
        "bmp" => image.write_to(&mut output, ImageFormat::Bmp),
        "tiff" => image.write_to(&mut output, ImageFormat::Tiff),
        "gif" => image.write_to(&mut output, ImageFormat::Gif),
        "ico" => image.write_to(&mut output, ImageFormat::Ico),
        _ => return Err(ImageCoreError::UnsupportedFormat(format.to_string())),
    }
    .map_err(|error| ImageCoreError::Encode(error.to_string()))?;
    Ok(output.into_inner())
}

#[derive(Debug, Serialize)]
struct OptionalFeatureStatus<'a> {
    name: &'a str,
    enabled: bool,
    owner: &'a str,
}

pub fn optional_feature_status() -> Vec<serde_json::Value> {
    [
        OptionalFeatureStatus {
            name: "pdf",
            enabled: cfg!(feature = "pdf"),
            owner: "pdfium-render adapter",
        },
        OptionalFeatureStatus {
            name: "onnx",
            enabled: cfg!(feature = "onnx"),
            owner: "ort adapter",
        },
        OptionalFeatureStatus {
            name: "c2pa",
            enabled: cfg!(feature = "c2pa"),
            owner: "c2pa-rs adapter",
        },
        OptionalFeatureStatus {
            name: "icc",
            enabled: cfg!(feature = "icc"),
            owner: "moxcms adapter",
        },
    ]
    .into_iter()
    .map(|status| serde_json::to_value(status).expect("feature status is serializable"))
    .collect()
}

#[cfg(feature = "napi")]
#[allow(dead_code)]
mod napi_exports {
    use super::{capabilities, optional_feature_status, process_raster, RasterOptions};
    use napi::bindgen_prelude::{Buffer, Error, Result};
    use napi_derive::napi;

    #[napi]
    pub fn capability_report() -> Result<String> {
        serde_json::to_string(&serde_json::json!({
            "capabilities": capabilities(),
            "optional_features": optional_feature_status(),
        }))
        .map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub fn process_raster_buffer(
        input: Buffer,
        format: String,
        width: Option<u32>,
        height: Option<u32>,
        quality: Option<u8>,
    ) -> Result<Buffer> {
        process_raster(
            input.as_ref(),
            &format,
            RasterOptions {
                width,
                height,
                quality: quality.unwrap_or(80),
            },
        )
        .map(Buffer::from)
        .map_err(|error| Error::from_reason(error.to_string()))
    }

    #[cfg(feature = "onnx")]
    #[napi]
    pub fn onnx_detect_buffer(
        input: Buffer,
        model_path: String,
        input_width: Option<u32>,
        input_height: Option<u32>,
        threads: Option<u32>,
        confidence_threshold: Option<f64>,
    ) -> Result<String> {
        let detections = crate::onnx::detect(
            input.as_ref(),
            &model_path,
            input_width.unwrap_or(640),
            input_height.unwrap_or(640),
            threads.unwrap_or(1) as usize,
            confidence_threshold.unwrap_or(0.25) as f32,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        serde_json::to_string(&detections).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[cfg(feature = "onnx")]
    #[napi]
    pub fn onnx_classify_buffer(
        input: Buffer,
        model_path: String,
        input_width: Option<u32>,
        input_height: Option<u32>,
        threads: Option<u32>,
    ) -> Result<String> {
        let classes = crate::onnx::classify(
            input.as_ref(),
            &model_path,
            input_width.unwrap_or(224),
            input_height.unwrap_or(224),
            threads.unwrap_or(1) as usize,
        )
        .map_err(|error| Error::from_reason(error.to_string()))?;
        serde_json::to_string(&classes).map_err(|error| Error::from_reason(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    #[test]
    fn reports_default_capability_boundary() {
        let report = capabilities();
        assert!(report.raster);
        assert!(!report.pdf);
        #[cfg(feature = "onnx")]
        assert!(report.onnx);
        #[cfg(not(feature = "onnx"))]
        assert!(!report.onnx);
        assert!(!report.c2pa);
        assert!(!report.icc);
    }

    #[test]
    fn resizes_and_encodes_a_png() {
        let source = ImageBuffer::<Rgba<u8>, _>::from_pixel(4, 2, Rgba([255, 0, 0, 255]));
        let mut bytes = Vec::new();
        DynamicImage::ImageRgba8(source)
            .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
            .unwrap();

        let output = process_raster(
            &bytes,
            "webp",
            RasterOptions {
                width: Some(2),
                height: Some(1),
                quality: 80,
            },
        )
        .unwrap();
        let decoded = image::load_from_memory(&output).unwrap();
        assert_eq!(decoded.dimensions(), (2, 1));
    }

    #[test]
    fn transcodes_bmp_and_tiff_inputs_to_supported_outputs() {
        for input_format in [ImageFormat::Bmp, ImageFormat::Tiff] {
            let source = ImageBuffer::<Rgba<u8>, _>::from_pixel(6, 4, Rgba([20, 140, 220, 255]));
            let mut input = Vec::new();
            DynamicImage::ImageRgba8(source)
                .write_to(&mut Cursor::new(&mut input), input_format)
                .unwrap();
            for output_format in ["jpeg", "png", "webp", "avif", "gif", "bmp", "tiff", "ico"] {
                let output = process_raster(
                    &input,
                    output_format,
                    RasterOptions {
                        width: Some(3),
                        height: Some(2),
                        quality: 80,
                    },
                )
                .unwrap_or_else(|error| {
                    panic!("{input_format:?} -> {output_format} failed: {error}")
                });
                assert!(
                    !output.is_empty(),
                    "{input_format:?} -> {output_format} empty"
                );
                if output_format != "avif" {
                    let decoded = image::load_from_memory(&output).unwrap();
                    assert_eq!(
                        decoded.dimensions(),
                        (3, 2),
                        "{input_format:?} -> {output_format} dimensions",
                    );
                }
            }
        }
    }
}
