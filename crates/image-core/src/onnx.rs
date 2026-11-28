use image::imageops::FilterType;
use image::ImageReader;
use ndarray::Array4;
use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Debug, thiserror::Error)]
pub enum OnnxError {
    #[error("ONNX runtime initialization failed: {0}")]
    Runtime(String),
    #[error("ONNX model loading failed: {0}")]
    Model(String),
    #[error("ONNX image decode failed: {0}")]
    Decode(String),
    #[error("ONNX model output is unsupported")]
    Output,
    #[error("ONNX inference failed: {0}")]
    Inference(String),
}

#[derive(Debug, Clone, Serialize)]
pub struct Detection {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub score: f32,
    pub class_id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Classification {
    pub class_id: i64,
    pub score: f32,
}

fn environment() -> Result<&'static ort::environment::Environment, OnnxError> {
    static ENVIRONMENT: OnceLock<Result<ort::environment::Environment, String>> = OnceLock::new();
    ENVIRONMENT
        .get_or_init(|| {
            ort::init()
                .with_name("supacloud-image-core")
                .with_telemetry(false)
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| OnnxError::Runtime(error.clone()))
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Mutex<Session>>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Mutex<Session>>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session(model_path: &str, threads: usize) -> Result<Arc<Mutex<Session>>, OnnxError> {
    let path = Path::new(model_path);
    if !path.is_file() {
        return Err(OnnxError::Model(format!(
            "model file does not exist: {model_path}"
        )));
    }
    let key = format!("{model_path}\0{threads}");
    let mut cached = sessions()
        .lock()
        .map_err(|_| OnnxError::Model("ONNX session cache is poisoned".to_string()))?;
    if let Some(session) = cached.get(&key) {
        return Ok(Arc::clone(session));
    }
    let session = Session::builder(environment()?)
        .map_err(|error| OnnxError::Model(error.to_string()))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| OnnxError::Model(error.to_string()))?
        .with_intra_threads(threads.max(1))
        .map_err(|error| OnnxError::Model(error.to_string()))?
        .commit_from_file(path)
        .map_err(|error| OnnxError::Model(error.to_string()))?;
    let session = Arc::new(Mutex::new(session));
    cached.insert(key, Arc::clone(&session));
    Ok(session)
}

fn image_tensor(
    input: &[u8],
    width: u32,
    height: u32,
) -> Result<(Array4<f32>, u32, u32), OnnxError> {
    let image = ImageReader::new(std::io::Cursor::new(input))
        .with_guessed_format()
        .map_err(|error| OnnxError::Decode(error.to_string()))?
        .decode()
        .map_err(|error| OnnxError::Decode(error.to_string()))?
        .to_rgb8();
    let source_width = image.width();
    let source_height = image.height();
    let resized = image::imageops::resize(&image, width, height, FilterType::Triangle);
    let mut tensor = Array4::<f32>::zeros((1, 3, height as usize, width as usize));
    for y in 0..height as usize {
        for x in 0..width as usize {
            let pixel = resized.get_pixel(x as u32, y as u32);
            tensor[[0, 0, y, x]] = f32::from(pixel[0]) / 255.0;
            tensor[[0, 1, y, x]] = f32::from(pixel[1]) / 255.0;
            tensor[[0, 2, y, x]] = f32::from(pixel[2]) / 255.0;
        }
    }
    Ok((tensor, source_width, source_height))
}

fn first_float_output(session: &mut Session, tensor: Array4<f32>) -> Result<Vec<f32>, OnnxError> {
    let input =
        Tensor::from_array(tensor).map_err(|error| OnnxError::Inference(error.to_string()))?;
    let outputs = session
        .run(ort::inputs![input])
        .map_err(|error| OnnxError::Inference(error.to_string()))?;
    if outputs.len() == 0 {
        return Err(OnnxError::Output);
    }
    let output = &outputs[0];
    let (_, values) = output
        .try_extract_tensor::<f32>()
        .map_err(|_| OnnxError::Output)?;
    Ok(values.to_vec())
}

pub fn detect(
    input: &[u8],
    model_path: &str,
    input_width: u32,
    input_height: u32,
    threads: usize,
    confidence_threshold: f32,
) -> Result<Vec<Detection>, OnnxError> {
    let (tensor, source_width, source_height) =
        image_tensor(input, input_width.max(1), input_height.max(1))?;
    let session = session(model_path, threads)?;
    let mut session = session
        .lock()
        .map_err(|_| OnnxError::Inference("ONNX session is poisoned".to_string()))?;
    let values = first_float_output(&mut session, tensor)?;
    if values.len() % 6 != 0 {
        return Err(OnnxError::Output);
    }
    let scale_x = source_width as f32 / input_width.max(1) as f32;
    let scale_y = source_height as f32 / input_height.max(1) as f32;
    Ok(values
        .chunks_exact(6)
        .filter_map(|value| {
            let score = value[4];
            if !score.is_finite() || score < confidence_threshold {
                return None;
            }
            let left = (value[0] * scale_x).clamp(0.0, source_width as f32);
            let top = (value[1] * scale_y).clamp(0.0, source_height as f32);
            let right = (value[2] * scale_x).clamp(left, source_width as f32);
            let bottom = (value[3] * scale_y).clamp(top, source_height as f32);
            Some(Detection {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
                score,
                class_id: value[5].round() as i64,
            })
        })
        .collect())
}

pub fn classify(
    input: &[u8],
    model_path: &str,
    input_width: u32,
    input_height: u32,
    threads: usize,
) -> Result<Vec<Classification>, OnnxError> {
    let (tensor, _, _) = image_tensor(input, input_width.max(1), input_height.max(1))?;
    let session = session(model_path, threads)?;
    let mut session = session
        .lock()
        .map_err(|_| OnnxError::Inference("ONNX session is poisoned".to_string()))?;
    let values = first_float_output(&mut session, tensor)?;
    if values.len() % 2 != 0 {
        return Err(OnnxError::Output);
    }
    Ok(values
        .chunks_exact(2)
        .filter_map(|value| {
            let score = value[1];
            score.is_finite().then_some(Classification {
                class_id: value[0].round() as i64,
                score,
            })
        })
        .collect())
}
