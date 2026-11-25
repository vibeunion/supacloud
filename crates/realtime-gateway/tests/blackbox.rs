//! Black-box fixtures for the Realtime gateway.
//!
//! The unit tests build routers in-process. These start the real binary, so the
//! startup contract (a control token is mandatory) and the shutdown contract
//! (SIGTERM drains) are covered along with the health and metrics payloads the
//! platform reads.
//!
//! Raw HTTP over `std::net::TcpStream`; no HTTP client dependency.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const EXIT_TIMEOUT: Duration = Duration::from_secs(15);
const CONTROL_TOKEN: &str = "fixture-realtime-control-token";

struct Server {
    child: Child,
    port: u16,
}

impl Server {
    fn start() -> Self {
        let port = free_port();
        let child = Command::new(env!("CARGO_BIN_EXE_supacloud-realtime-gateway"))
            .env("REALTIME_BIND_HOST", "127.0.0.1")
            .env("REALTIME_PORT", port.to_string())
            .env("REALTIME_CONTROL_TOKEN", CONTROL_TOKEN)
            .env(
                "API_JWT_SECRET",
                "fixture-jwt-secret-at-least-32-characters",
            )
            .env("RUST_LOG", "error")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("realtime gateway should start");
        let server = Self { child, port };
        server.wait_until_ready();
        server
    }

    fn wait_until_ready(&self) {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(response) = self.try_request("GET", "/healthcheck", &[]) {
                if response.status == 200 {
                    return;
                }
            }
            sleep(Duration::from_millis(50));
        }
        panic!("realtime gateway did not answer /healthcheck within {READY_TIMEOUT:?}");
    }

    fn request(&self, method: &str, path: &str, headers: &[(&str, &str)]) -> Response {
        self.try_request(method, path, headers)
            .expect("server should answer while it is running")
    }

    fn try_request(&self, method: &str, path: &str, headers: &[(&str, &str)]) -> Option<Response> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .ok()?;
        let mut request =
            format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).ok()?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).ok()?;
        Some(Response::parse(&raw))
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
    body: String,
}

impl Response {
    fn parse(raw: &[u8]) -> Self {
        let text = String::from_utf8_lossy(raw).into_owned();
        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .expect("status line should carry a status code");
        Self {
            status,
            body: body.to_owned(),
        }
    }

    fn json(&self) -> serde_json::Value {
        serde_json::from_str(&self.body)
            .unwrap_or_else(|error| panic!("response body was not JSON ({error}): {}", self.body))
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

#[test]
fn health_reports_the_engine_and_empty_hub_counts() {
    let server = Server::start();
    for path in ["/", "/healthcheck", "/api/health", "/realtime/v1/health"] {
        let response = server.request("GET", path, &[]);
        assert_eq!(response.status, 200, "{path} should answer 200");
        let payload = response.json();
        assert_eq!(payload["status"], "ok", "{path}: {payload}");
        assert_eq!(payload["engine"], "supacloud-realtime-gateway/rust");
        assert_eq!(payload["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(payload["connections"], 0, "no client connected yet");
        assert_eq!(payload["topics"], 0, "no channel opened yet");
    }
}

#[test]
fn metrics_render_the_two_gauges() {
    let server = Server::start();
    let response = server.request("GET", "/metrics", &[]);
    assert_eq!(response.status, 200);
    assert!(response.body.contains("supacloud_realtime_connections 0"));
    assert!(response.body.contains("supacloud_realtime_topics 0"));
}

#[test]
fn control_routes_require_the_control_token() {
    let server = Server::start();

    let missing = server.request("GET", "/api/tenants", &[]);
    assert_eq!(missing.status, 401, "no bearer token must be refused");

    let wrong = server.request(
        "GET",
        "/api/tenants",
        &[("Authorization", "Bearer not-the-token")],
    );
    assert_eq!(wrong.status, 401, "a wrong token must be refused");

    let allowed = server.request(
        "GET",
        "/api/tenants",
        &[("Authorization", &format!("Bearer {CONTROL_TOKEN}"))],
    );
    assert_eq!(allowed.status, 200, "the control token must open the route");
}

#[test]
fn a_missing_control_token_stops_the_process_instead_of_serving() {
    // Fail closed: without the token the control API would be an unauthenticated
    // way to register tenants and broadcast. The binary must refuse to start.
    let port = free_port();
    let output = Command::new(env!("CARGO_BIN_EXE_supacloud-realtime-gateway"))
        .env("REALTIME_BIND_HOST", "127.0.0.1")
        .env("REALTIME_PORT", port.to_string())
        .env_remove("REALTIME_CONTROL_TOKEN")
        .env("RUST_LOG", "error")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("the binary should run");

    assert!(
        !output.status.success(),
        "the gateway must exit non-zero without REALTIME_CONTROL_TOKEN"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("REALTIME_CONTROL_TOKEN is required"),
        "startup should name the missing token, got: {stderr}"
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
