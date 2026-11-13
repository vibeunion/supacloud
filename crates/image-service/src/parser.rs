//! URL Path parser matching Imagor and Thumbor specifications with imgproxy Pro enhancements.

use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetFormat {
    Avif,
    WebP,
    Jpeg,
    Png,
    Gif,
    Bmp,
    Tiff,
}

impl TargetFormat {
    pub fn mime_type(&self) -> &'static str {
        match self {
            TargetFormat::Avif => "image/avif",
            TargetFormat::WebP => "image/webp",
            TargetFormat::Jpeg => "image/jpeg",
            TargetFormat::Png => "image/png",
            TargetFormat::Gif => "image/gif",
            TargetFormat::Bmp => "image/bmp",
            TargetFormat::Tiff => "image/tiff",
        }
    }
}

impl FromStr for TargetFormat {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "avif" => Ok(TargetFormat::Avif),
            "webp" => Ok(TargetFormat::WebP),
            "jpeg" | "jpg" => Ok(TargetFormat::Jpeg),
            "png" => Ok(TargetFormat::Png),
            "gif" => Ok(TargetFormat::Gif),
            "bmp" => Ok(TargetFormat::Bmp),
            "tiff" | "tif" => Ok(TargetFormat::Tiff),
            _ => Err(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransformOptions {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fit_in: bool,
    pub stretch: bool,
    pub smart: bool,
    pub flip_horizontal: bool,
    pub flip_vertical: bool,
    pub format: Option<TargetFormat>,
    pub quality: u8,
    pub blur_sigma: Option<f32>,
    pub sharpen_sigma: Option<f32>,
    pub contrast: Option<f32>,
    pub brightness: Option<i32>,
    pub grayscale: bool,
    pub invert: bool,
    pub rotate_deg: Option<u32>,
    pub is_meta: bool,
}

impl Default for TransformOptions {
    fn default() -> Self {
        Self {
            width: None,
            height: None,
            fit_in: false,
            stretch: false,
            smart: false,
            flip_horizontal: false,
            flip_vertical: false,
            format: None,
            quality: 80,
            blur_sigma: None,
            sharpen_sigma: None,
            contrast: None,
            brightness: None,
            grayscale: false,
            invert: false,
            rotate_deg: None,
            is_meta: false,
        }
    }
}

/// Parses a path like `/fit-in/300x200/filters:format(webp):quality(85)/`
pub fn parse_path(path: &str) -> TransformOptions {
    let mut options = TransformOptions::default();
    let trimmed = path.trim_matches('/');
    if trimmed.is_empty() {
        return options;
    }

    let segments: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    for seg in segments {
        if seg == "meta" || seg == "info" {
            options.is_meta = true;
            continue;
        }
        if seg == "fit-in" || seg == "adaptive-fit-in" || seg == "full-fit-in" || seg == "adaptive-full-fit-in" {
            options.fit_in = true;
            continue;
        }
        if seg == "stretch" {
            options.stretch = true;
            continue;
        }
        if seg == "smart" {
            options.smart = true;
            continue;
        }

        // Check for filters segment: filters:...
        if let Some(filters_content) = seg.strip_prefix("filters:") {
            parse_filters(filters_content, &mut options);
            continue;
        }

        // Check for geometry: e.g. "300x200", "-300x200", "300x-200", "300x0", "0x200"
        if let Some(dim) = parse_geometry(seg) {
            options.width = dim.0;
            options.height = dim.1;
            options.flip_horizontal = dim.2;
            options.flip_vertical = dim.3;
        }
    }

    options
}

fn parse_geometry(s: &str) -> Option<(Option<u32>, Option<u32>, bool, bool)> {
    let (w_str, h_str) = s.split_once('x')?;
    let mut flip_h = false;
    let mut flip_v = false;

    let w_clean = if let Some(stripped) = w_str.strip_prefix('-') {
        flip_h = true;
        stripped
    } else {
        w_str
    };

    let h_clean = if let Some(stripped) = h_str.strip_prefix('-') {
        flip_v = true;
        stripped
    } else {
        h_str
    };

    let width = w_clean.parse::<u32>().ok().filter(|&w| w > 0);
    let height = h_clean.parse::<u32>().ok().filter(|&h| h > 0);

    if width.is_some() || height.is_some() {
        Some((width, height, flip_h, flip_v))
    } else {
        None
    }
}

fn parse_filters(content: &str, options: &mut TransformOptions) {
    // Filters are separated by colons: format(webp):quality(80):blur(5)
    for filter in content.split(':') {
        let trimmed = filter.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some((name, args_str)) = split_filter(trimmed) {
            match name {
                "format" => {
                    if let Ok(fmt) = TargetFormat::from_str(args_str) {
                        options.format = Some(fmt);
                    }
                }
                "quality" => {
                    if let Ok(q) = args_str.parse::<u8>() {
                        options.quality = q.clamp(1, 100);
                    }
                }
                "blur" => {
                    // blur(sigma) or blur(radius, sigma)
                    if let Some(sigma) = args_str.split(',').next().and_then(|s| s.trim().parse::<f32>().ok()) {
                        options.blur_sigma = Some(sigma.max(0.1));
                    }
                }
                "sharpen" => {
                    if let Ok(sigma) = args_str.parse::<f32>() {
                        options.sharpen_sigma = Some(sigma.max(0.1));
                    }
                }
                "contrast" => {
                    if let Ok(c) = args_str.parse::<f32>() {
                        options.contrast = Some(c);
                    }
                }
                "brightness" => {
                    if let Ok(b) = args_str.parse::<i32>() {
                        options.brightness = Some(b);
                    }
                }
                "grayscale" => {
                    options.grayscale = true;
                }
                "invert" => {
                    options.invert = true;
                }
                "rotate" => {
                    if let Ok(deg) = args_str.parse::<u32>() {
                        options.rotate_deg = Some(deg);
                    }
                }
                _ => {}
            }
        }
    }
}

fn split_filter(f: &str) -> Option<(&str, &str)> {
    let open_idx = f.find('(')?;
    let close_idx = f.rfind(')')?;
    if close_idx > open_idx {
        let name = &f[..open_idx];
        let args = &f[open_idx + 1..close_idx];
        Some((name, args))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_standard_path() {
        let opt = parse_path("/fit-in/400x300/filters:format(webp):quality(85)/");
        assert_eq!(opt.width, Some(400));
        assert_eq!(opt.height, Some(300));
        assert!(opt.fit_in);
        assert_eq!(opt.format, Some(TargetFormat::WebP));
        assert_eq!(opt.quality, 85);
        assert!(!opt.is_meta);
    }

    #[test]
    fn test_parse_filters_and_effects() {
        let opt = parse_path("/300x0/smart/filters:format(jpeg):quality(90):blur(2.5):grayscale():rotate(90)/");
        assert_eq!(opt.width, Some(300));
        assert_eq!(opt.height, None);
        assert!(opt.smart);
        assert_eq!(opt.format, Some(TargetFormat::Jpeg));
        assert_eq!(opt.quality, 90);
        assert_eq!(opt.blur_sigma, Some(2.5));
        assert!(opt.grayscale);
        assert_eq!(opt.rotate_deg, Some(90));
    }

    #[test]
    fn test_parse_avif_and_negotiate_by_default() {
        let explicit = parse_path("/filters:format(avif):quality(72)/");
        assert_eq!(explicit.format, Some(TargetFormat::Avif));
        assert_eq!(explicit.quality, 72);

        let negotiated = parse_path("/fit-in/320x240/");
        assert_eq!(negotiated.format, None);
    }

    #[test]
    fn test_parse_meta() {
        let opt = parse_path("/meta/");
        assert!(opt.is_meta);
    }
}
