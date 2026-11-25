//! Black-box fixtures for the image service.
//!
//! The unit tests drive `process_image` directly. These start the real binary so
//! the things only the socket can show are covered: the listener binds, the
//! engine header is set on every response, an empty payload is rejected before
//! the decoder, a real PNG round-trips through a path expression, and SIGTERM
//! drains the server.
//!
//! One raw HTTP request over `std::net::TcpStream` per call; no HTTP client
//! dependency, and bodies are binary so the response is assembled from bytes.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const EXIT_TIMEOUT: Duration = Duration::from_secs(15);

struct Server {
    child: Child,
    port: u16,
}

impl Server {
    fn start() -> Self {
        let port = free_port();
        let child = Command::new(env!("CARGO_BIN_EXE_supacloud-image-service"))
            .env("IMAGE_SERVICE_HOST", "127.0.0.1")
            .env("IMAGE_SERVICE_PORT", port.to_string())
            .env("RUST_LOG", "error")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("image service should start");
        let server = Self { child, port };
        server.wait_until_ready();
        server
    }

    fn wait_until_ready(&self) {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(response) = self.try_request("GET", "/healthcheck", &[], &[]) {
                if response.status == 200 {
                    return;
                }
            }
            sleep(Duration::from_millis(50));
        }
        panic!("image service did not answer /healthcheck within {READY_TIMEOUT:?}");
    }

    fn request(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> Response {
        self.try_request(method, path, headers, body)
            .expect("server should answer while it is running")
    }

    fn try_request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Option<Response> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .ok()?;
        let mut request =
            format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        if !body.is_empty() {
            request.push_str("Content-Type: application/octet-stream\r\n");
            request.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        request.push_str("\r\n");
        let mut raw = request.into_bytes();
        raw.extend_from_slice(body);
        stream.write_all(&raw).ok()?;
        let mut response = Vec::new();
        stream.read_to_end(&mut response).ok()?;
        Some(Response::parse(&response))
    }

    fn terminate(&mut self) -> Option<std::process::ExitStatus> {
        let status = Command::new("kill")
            .arg("-TERM")
            .arg(self.child.id().to_string())
            .status()
            .expect("kill should be available");
        assert!(status.success(), "SIGTERM should reach the server process");

        let deadline = Instant::now() + EXIT_TIMEOUT;
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(status)) => return Some(status),
                Ok(None) => sleep(Duration::from_millis(50)),
                Err(error) => panic!("waiting for the server failed: {error}"),
            }
        }
        None
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Response {
    fn parse(raw: &[u8]) -> Self {
        // Split on the first empty line; the body may contain any byte.
        let separator = raw
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("response should carry a header terminator");
        let head = String::from_utf8_lossy(&raw[..separator]).into_owned();
        let body = raw[separator + 4..].to_vec();

        let mut lines = head.lines();
        let status = lines
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .expect("status line should carry a status code");
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect();

        Self {
            status,
            headers,
            body,
        }
    }

    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(candidate, _)| candidate == name)
            .map(|(_, value)| value.as_str())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("response body was not JSON ({error}): {:?}", self.body))
    }
}

fn free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("a free port should be bindable");
    let port = listener
        .local_addr()
        .expect("the listener should report its address")
        .port();
    drop(listener);
    port
}

/// A 4x2 PNG encoded by the crate's own `image` dependency, so the fixture does
/// not carry a binary blob in the repository.
fn png(width: u32, height: u32) -> Vec<u8> {
    let mut buffer = image::RgbaImage::new(width, height);
    for (x, y, pixel) in buffer.enumerate_pixels_mut() {
        *pixel = image::Rgba([(x % 256) as u8, (y % 256) as u8, 0x40, 0xff]);
    }
    let mut bytes = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(buffer)
        .write_to(&mut bytes, image::ImageFormat::Png)
        .expect("the fixture image should encode");
    bytes.into_inner()
}

#[test]
fn health_is_served_with_the_engine_header() {
    let server = Server::start();
    for path in ["/health", "/healthcheck"] {
        let response = server.request("GET", path, &[], &[]);
        assert_eq!(response.status, 200, "{path} should answer 200");
        assert_eq!(
            response.header("x-image-engine"),
            Some("supacloud-image/rust"),
            "{path} should identify the engine on the response"
        );
        assert_eq!(
            response.json(),
            serde_json::json!({
                "status": "healthy",
                "engine": "supacloud-image/rust",
                "version": env!("CARGO_PKG_VERSION"),
            })
        );
    }
}

#[test]
fn an_empty_payload_is_rejected_before_the_decoder() {
    let server = Server::start();
    let response = server.request("POST", "/", &[], b"");
    assert_eq!(response.status, 400);
    assert_eq!(response.text(), "Empty image payload");
    assert_eq!(
        response.header("x-image-engine"),
        Some("supacloud-image/rust")
    );
}

#[test]
fn a_png_round_trips_through_a_path_expression() {
    let server = Server::start();
    let source = png(4, 2);
    // The management API builds `filters:format(..)` paths, so this is the
    // expression production traffic actually uses.
    let response = server.request("POST", "/fit-in/2x1/filters:format(png)", &[], &source);
    assert_eq!(
        response.status,
        200,
        "transform failed: {}",
        response.text()
    );
    assert_eq!(response.header("content-type"), Some("image/png"));
    assert_eq!(
        response.header("x-image-engine"),
        Some("supacloud-image/rust")
    );

    let decoded = image::load_from_memory_with_format(&response.body, image::ImageFormat::Png)
        .expect("the response should be a PNG");
    assert!(
        decoded.width() <= 2 && decoded.height() <= 1,
        "expected at most 2x1, got {}x{}",
        decoded.width(),
        decoded.height()
    );
}

#[test]
fn an_unspecified_format_is_negotiated_and_defaults_to_webp() {
    let server = Server::start();
    let source = png(4, 2);

    let default = server.request("POST", "/fit-in/2x1", &[], &source);
    assert_eq!(default.status, 200, "transform failed: {}", default.text());
    assert_eq!(default.header("content-type"), Some("image/webp"));
    // When the format was not pinned, the response depends on `Accept`.
    assert_eq!(default.header("vary"), Some("Accept"));

    let negotiated = server.request("POST", "/fit-in/2x1", &[("Accept", "image/webp")], &source);
    assert_eq!(negotiated.status, 200);
    assert_eq!(negotiated.header("content-type"), Some("image/webp"));
}

#[test]
fn a_non_image_payload_is_rejected_as_unsupported_media() {
    let server = Server::start();
    let response = server.request("POST", "/fit-in/2x1/png", &[], b"this is not an image");
    assert_eq!(response.status, 415);
    assert_eq!(
        response.header("x-image-engine"),
        Some("supacloud-image/rust")
    );
}

#[test]
fn a_get_on_a_transform_path_does_not_transform() {
    let server = Server::start();
    let response = server.request("GET", "/fit-in/2x1/png", &[], &[]);
    assert_eq!(response.status, 405);
    assert!(
        response
            .text()
            .contains("POST request with raw image bytes required"),
        "unexpected body: {}",
        response.text()
    );
}

#[test]
fn sigterm_stops_the_server_cleanly() {
    let mut server = Server::start();
    let status = server
        .terminate()
        .expect("the server should exit after SIGTERM instead of hanging");
    assert!(
        status.success(),
        "graceful shutdown should exit successfully, got {status:?}"
    );
}
