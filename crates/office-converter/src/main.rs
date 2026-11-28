use std::env;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use office_oxide::Document;

fn usage() -> &'static str {
    "usage: supacloud-office-converter --input PATH --output PATH"
}

fn argument(args: &[String], name: &str) -> Result<PathBuf, String> {
    let index = args
        .iter()
        .position(|arg| arg == name)
        .ok_or_else(|| usage().to_string())?;
    args.get(index + 1)
        .filter(|value| !value.is_empty() && !value.starts_with('-'))
        .map(PathBuf::from)
        .ok_or_else(|| usage().to_string())
}

fn extension(path: &Path) -> Result<String, String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "missing file extension".to_string())
}

fn expected_output(input: &str) -> Option<&'static str> {
    match input {
        "doc" => Some("docx"),
        "xls" => Some("xlsx"),
        "ppt" => Some("pptx"),
        _ => None,
    }
}

fn convert(input: &Path, output: &Path) -> Result<(), String> {
    let input_ext = extension(input)?;
    let output_ext = extension(output)?;
    let expected = expected_output(&input_ext)
        .ok_or_else(|| "only .doc, .xls and .ppt inputs are supported".to_string())?;
    if output_ext != expected {
        return Err(format!("output extension must be .{expected}"));
    }
    if !input.is_file() {
        return Err("input is not a regular file".to_string());
    }

    let document = Document::open(input).map_err(|error| format!("open failed: {error}"))?;
    document
        .save_as(output)
        .map_err(|error| format!("conversion failed: {error}"))?;
    if !output.is_file() {
        return Err("converter did not produce an output file".to_string());
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!("{}", usage());
        return ExitCode::SUCCESS;
    }

    let input = match argument(&args, "--input") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    let output = match argument(&args, "--output") {
        Ok(path) => path,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::from(2);
        }
    };
    if args.iter().any(|arg| {
        arg != "--input"
            && arg != "--output"
            && arg != input.to_string_lossy().as_ref()
            && arg != output.to_string_lossy().as_ref()
    }) {
        eprintln!("{}", usage());
        return ExitCode::from(2);
    }

    match convert(&input, &output) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(1)
        }
    }
}
