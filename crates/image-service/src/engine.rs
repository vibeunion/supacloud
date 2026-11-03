//! High-performance SIMD Image Processing Pipeline with imgproxy Pro inspired features.

use crate::parser::{TargetFormat, TransformOptions};
use fast_image_resize::images::Image;
use fast_image_resize::{PixelType, Resizer};
use image::{imageops, DynamicImage, GenericImageView, ImageFormat, ImageReader, RgbaImage};
use std::io::Cursor;

pub const MAX_IMAGE_WIDTH: u32 = 10000;
pub const MAX_IMAGE_HEIGHT: u32 = 10000;
pub const MAX_IMAGE_PIXELS: u64 = 50_000_000; // Protection against decompression bombs
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024 * 1024; // 64 MiB

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("Image exceeds maximum payload size of {0} bytes")]
    PayloadTooLarge(usize),
    #[error("Failed to decode image: {0}")]
    DecodeError(String),
    #[error("Image dimensions ({0}x{1}) exceed maximum allowed pixels ({2})")]
    DimensionsTooLarge(u32, u32, u64),
    #[error("Failed to resize image: {0}")]
    ResizeError(String),
    #[error("Failed to encode image: {0}")]
    EncodeError(String),
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ImageMetadata {
    pub format: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: usize,
    pub has_alpha: bool,
}

pub struct ProcessedOutput {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

/// Main pipeline: validates, decodes, resizes via SIMD, applies filters, and encodes.
pub fn process_image(raw: &[u8], options: &TransformOptions) -> Result<ProcessedOutput, EngineError> {
    if raw.len() > MAX_PAYLOAD_BYTES {
        return Err(EngineError::PayloadTooLarge(MAX_PAYLOAD_BYTES));
    }

    // Guess format and decode bounds
    let reader = ImageReader::new(Cursor::new(raw))
        .with_guessed_format()
        .map_err(|e| EngineError::DecodeError(e.to_string()))?;

    let format_hint = reader.format();
    let mut dyn_img = reader.decode().map_err(|e| EngineError::DecodeError(e.to_string()))?;
    let (orig_w, orig_h) = dyn_img.dimensions();

    let total_pixels = (orig_w as u64) * (orig_h as u64);
    if total_pixels > MAX_IMAGE_PIXELS || orig_w > MAX_IMAGE_WIDTH || orig_h > MAX_IMAGE_HEIGHT {
        return Err(EngineError::DimensionsTooLarge(orig_w, orig_h, MAX_IMAGE_PIXELS));
    }

    // Metadata extraction mode (info / meta)
    if options.is_meta {
        let meta = ImageMetadata {
            format: format_hint.map(|f| format!("{:?}", f).to_lowercase()).unwrap_or_else(|| "unknown".into()),
            width: orig_w,
            height: orig_h,
            size_bytes: raw.len(),
            has_alpha: dyn_img.color().has_alpha(),
        };
        let json_bytes = serde_json::to_vec_pretty(&meta).map_err(|e| EngineError::EncodeError(e.to_string()))?;
        return Ok(ProcessedOutput {
            bytes: json_bytes,
            content_type: "application/json",
        });
    }

    // 1. Calculate target dimensions and crop if necessary
    if let Some((target_w, target_h)) = calculate_target_dims(orig_w, orig_h, options) {
        if target_w != orig_w || target_h != orig_h {
            dyn_img = resize_simd(&dyn_img, orig_w, orig_h, target_w, target_h, options)?;
        }
    }

    // 2. Apply transformations & filters (imgproxy Pro inspired)
    apply_filters(&mut dyn_img, options);

    // 3. Encode to target format
    let target_format = options.format.unwrap_or(TargetFormat::WebP);
    let output_bytes = encode_image(&dyn_img, target_format, options.quality)?;

    Ok(ProcessedOutput {
        bytes: output_bytes,
        content_type: target_format.mime_type(),
    })
}

fn calculate_target_dims(
    orig_w: u32,
    orig_h: u32,
    options: &TransformOptions,
) -> Option<(u32, u32)> {
    match (options.width, options.height) {
        (Some(w), Some(h)) => {
            if options.fit_in {
                let ratio = (w as f64 / orig_w as f64).min(h as f64 / orig_h as f64);
                let rw = (orig_w as f64 * ratio).round().max(1.0) as u32;
                let rh = (orig_h as f64 * ratio).round().max(1.0) as u32;
                Some((rw, rh))
            } else {
                Some((w, h))
            }
        }
        (Some(w), None) => {
            let ratio = w as f64 / orig_w as f64;
            let rh = (orig_h as f64 * ratio).round().max(1.0) as u32;
            Some((w, rh))
        }
        (None, Some(h)) => {
            let ratio = h as f64 / orig_h as f64;
            let rw = (orig_w as f64 * ratio).round().max(1.0) as u32;
            Some((rw, h))
        }
        (None, None) => None,
    }
}

fn resize_simd(
    src: &DynamicImage,
    _orig_w: u32,
    _orig_h: u32,
    target_w: u32,
    target_h: u32,
    options: &TransformOptions,
) -> Result<DynamicImage, EngineError> {
    // If not fit_in and not stretch, crop to aspect ratio before resizing (smart/center crop)
    let img_to_resize = if !options.fit_in && !options.stretch && options.width.is_some() && options.height.is_some() {
        let (crop_x, crop_y, crop_w, crop_h) = calculate_crop_rect(src.width(), src.height(), target_w, target_h);
        src.crop_imm(crop_x, crop_y, crop_w, crop_h)
    } else {
        src.clone()
    };

    let rgba_src = img_to_resize.to_rgba8();
    let mut dst_image = Image::new(target_w, target_h, PixelType::U8x4);
    let mut resizer = Resizer::new();
    resizer
        .resize(&rgba_src, &mut dst_image, None)
        .map_err(|e| EngineError::ResizeError(e.to_string()))?;

    let out_rgba = RgbaImage::from_raw(target_w, target_h, dst_image.into_vec())
        .ok_or_else(|| EngineError::ResizeError("Failed to extract RGBA pixel buffer".into()))?;

    Ok(DynamicImage::ImageRgba8(out_rgba))
}

fn calculate_crop_rect(orig_w: u32, orig_h: u32, target_w: u32, target_h: u32) -> (u32, u32, u32, u32) {
    let target_aspect = target_w as f64 / target_h as f64;
    let orig_aspect = orig_w as f64 / orig_h as f64;

    if orig_aspect > target_aspect {
        // Image is wider than target aspect ratio -> crop sides
        let new_w = (orig_h as f64 * target_aspect).round() as u32;
        let offset_x = (orig_w.saturating_sub(new_w)) / 2;
        (offset_x, 0, new_w, orig_h)
    } else {
        // Image is taller than target aspect ratio -> crop top/bottom
        let new_h = (orig_w as f64 / target_aspect).round() as u32;
        let offset_y = (orig_h.saturating_sub(new_h)) / 2;
        (0, offset_y, orig_w, new_h)
    }
}

fn apply_filters(img: &mut DynamicImage, options: &TransformOptions) {
    // Orientation
    if options.flip_horizontal {
        *img = img.fliph();
    }
    if options.flip_vertical {
        *img = img.flipv();
    }
    if let Some(deg) = options.rotate_deg {
        match deg % 360 {
            90 => *img = img.rotate90(),
            180 => *img = img.rotate180(),
            270 => *img = img.rotate270(),
            _ => {}
        }
    }

    // Color adjustments
    if options.grayscale {
        *img = img.grayscale();
    }
    if options.invert {
        img.invert();
    }
    if let Some(c) = options.contrast {
        if c != 0.0 {
            *img = DynamicImage::ImageRgba8(imageops::contrast(img, c));
        }
    }
    if let Some(b) = options.brightness {
        if b != 0 {
            *img = DynamicImage::ImageRgba8(imageops::brighten(img, b));
        }
    }

    // Blur & Sharpen
    if let Some(sigma) = options.blur_sigma {
        if sigma > 0.0 {
            *img = DynamicImage::ImageRgba8(imageops::blur(img, sigma));
        }
    }
    if let Some(sigma) = options.sharpen_sigma {
        if sigma > 0.0 {
            *img = DynamicImage::ImageRgba8(imageops::unsharpen(img, sigma, 1));
        }
    }
}

fn encode_image(img: &DynamicImage, format: TargetFormat, _quality: u8) -> Result<Vec<u8>, EngineError> {
    let mut buffer = Cursor::new(Vec::new());
    let target_format = match format {
        TargetFormat::WebP => ImageFormat::WebP,
        TargetFormat::Jpeg => ImageFormat::Jpeg,
        TargetFormat::Png => ImageFormat::Png,
        TargetFormat::Gif => ImageFormat::Gif,
        TargetFormat::Bmp => ImageFormat::Bmp,
        TargetFormat::Tiff => ImageFormat::Tiff,
    };

    img.write_to(&mut buffer, target_format)
        .map_err(|e| EngineError::EncodeError(e.to_string()))?;

    Ok(buffer.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_image(w: u32, h: u32) -> Vec<u8> {
        let img = DynamicImage::ImageRgba8(RgbaImage::new(w, h));
        let mut cur = Cursor::new(Vec::new());
        img.write_to(&mut cur, ImageFormat::Png).unwrap();
        cur.into_inner()
    }

    #[test]
    fn test_process_resize_webp() {
        let png_bytes = create_test_image(200, 100);
        let mut opt = TransformOptions::default();
        opt.width = Some(100);
        opt.height = Some(50);
        opt.format = Some(TargetFormat::WebP);

        let out = process_image(&png_bytes, &opt).unwrap();
        assert_eq!(out.content_type, "image/webp");
        assert!(!out.bytes.is_empty());
    }

    #[test]
    fn test_process_metadata() {
        let png_bytes = create_test_image(120, 80);
        let mut opt = TransformOptions::default();
        opt.is_meta = true;

        let out = process_image(&png_bytes, &opt).unwrap();
        assert_eq!(out.content_type, "application/json");
        let meta: ImageMetadata = serde_json::from_slice(&out.bytes).unwrap();
        assert_eq!(meta.width, 120);
        assert_eq!(meta.height, 80);
    }
}
