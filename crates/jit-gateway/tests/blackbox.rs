//! Black-box fixtures for the JIT database gateway.
//!
//! These start the real binary and talk HTTP to it, so they cover what the unit
//! tests cannot: the listener binds, the manifest the drift check compares
//! against is actually served, the control routes refuse a request without the
//! bearer token, and SIGTERM drains the server instead of killing it.
//!
//! No HTTP client dependency: a fixture that adds `reqwest` to prove a health
//! endpoint answers is a poor trade. `std::net::TcpStream` and one raw request
//! line are enough for `Connection: close` responses.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const EXIT_TIMEOUT: Duration = Duration::from_secs(15);
const CONTROL_TOKEN: &str = "fixture-control-token";

struct Server {
    child: Child,
    port: u16,
}

impl Server {
    fn start(extra_env: &[(&str, &str)]) -> Self {
        let port = free_port();
        let mut command = Command::new(env!("CARGO_BIN_EXE_supacloud-jit-gateway"));
        command
            .env("JIT_GATEWAY_CONTROL_HOST", "127.0.0.1")
            .env("JIT_GATEWAY_CONTROL_PORT", port.to_string())
            .env("RUST_LOG", "error")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        for (name, value) in extra_env {
            command.env(name, value);
        }
        let child = command.spawn().expect("jit gateway should start");
        let server = Self { child, port };
        server.wait_until_ready();
        server
    }

    fn wait_until_ready(&self) {
        let deadline = Instant::now() + READY_TIMEOUT;
        while Instant::now() < deadline {
            if let Some(response) = self.try_request("GET /healthcheck HTTP/1.1") {
                if response.status == 200 {
                    return;
                }
            }
            sleep(Duration::from_millis(50));
        }
        panic!("jit gateway did not answer /healthcheck within {READY_TIMEOUT:?}");
    }

    fn request(&self, line: &str, headers: &[(&str, &str)], body: &str) -> Response {
        self.try_request_with(line, headers, body)
            .expect("server should answer while it is running")
    }

    fn try_request(&self, line: &str) -> Option<Response> {
        self.try_request_with(line, &[], "")
    }

    fn try_request_with(
        &self,
        line: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> Option<Response> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).ok()?;
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .ok()?;
        let mut request = format!("{line}\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
        for (name, value) in headers {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        if !body.is_empty() {
            request.push_str("Content-Type: application/json\r\n");
            request.push_str(&format!("Content-Length: {}\r\n", body.len()));
        }
        request.push_str("\r\n");
        request.push_str(body);
        stream.write_all(request.as_bytes()).ok()?;
        let mut raw = Vec::new();
        stream.read_to_end(&mut raw).ok()?;
        Some(Response::parse(&raw))
    }

    fn terminate(&mut self) -> Option<std::process::ExitStatus> {
        // SIGTERM, not SIGKILL: the point is the graceful path in
        // `supacloud_runtime_core::shutdown_signal`.
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
fn health_is_served_with_a_stable_payload() {
    let server = Server::start(&[("JIT_GATEWAY_CONTROL_TOKEN", CONTROL_TOKEN)]);
    for path in ["/health", "/healthcheck"] {
        let response = server.request(&format!("GET {path} HTTP/1.1"), &[], "");
        assert_eq!(response.status, 200, "{path} should answer 200");
        assert_eq!(
            response.json(),
            serde_json::json!({
                "status": "healthy",
                "engine": "supacloud-jit-gateway/rust",
                "version": env!("CARGO_PKG_VERSION"),
            }),
            "{path} should serve the shared health payload"
        );
    }
}

#[test]
fn manifest_lists_exactly_the_routes_the_server_registers() {
    let server = Server::start(&[("JIT_GATEWAY_CONTROL_TOKEN", CONTROL_TOKEN)]);
    let response = server.request("GET /manifest HTTP/1.1", &[], "");
    assert_eq!(response.status, 200);
    let manifest = response.json();

    assert_eq!(manifest["schema"], "supacloud.rust-boundary.v1");
    assert_eq!(manifest["service"], "jit-gateway");
    assert_eq!(manifest["engine"], "axum-tower");
    assert_eq!(manifest["version"], env!("CARGO_PKG_VERSION"));

    let declared: Vec<String> = manifest["routes"]
        .as_array()
        .expect("manifest should declare routes")
        .iter()
        .map(|route| route.as_str().expect("routes are strings").to_owned())
        .collect();
    assert_eq!(declared.len(), 7, "declared routes: {declared:?}");

    // Every declared route must exist on the listener. A manifest that lists a
    // path the router does not serve is worse than no manifest: the drift check
    // then compares against a fiction. Expect a status that is not 404, since
    // authentication answers 401 before routing does not.
    for route in &declared {
        let mut parts = route.splitn(2, ' ');
        let method = parts.next().expect("method");
        let path = parts
            .next()
            .unwrap_or_else(|| panic!("route must be 'METHOD /path': {route}"))
            .replace(":credential_id", "fixture-credential");
        let response = server.request(&format!("{method} {path} HTTP/1.1"), &[], "");
        assert_ne!(response.status, 404, "{route} is declared but not served");
    }
}

#[test]
fn control_routes_require_the_bearer_token() {
    let server = Server::start(&[("JIT_GATEWAY_CONTROL_TOKEN", CONTROL_TOKEN)]);
    let body = r#"{"credential_id":"fixture"}"#;

    let missing = server.request("GET /v1/bindings HTTP/1.1", &[], "");
    assert_eq!(
        missing.status, 401,
        "no Authorization header must be refused"
    );
    assert_eq!(missing.json()["message"], "unauthorized");

    let wrong = server.request(
        "GET /v1/bindings HTTP/1.1",
        &[("Authorization", "Bearer not-the-token")],
        "",
    );
    assert_eq!(wrong.status, 401, "a wrong token must be refused");

    let allowed = server.request(
        "GET /v1/bindings HTTP/1.1",
        &[("Authorization", &format!("Bearer {CONTROL_TOKEN}"))],
        "",
    );
    assert_eq!(allowed.status, 200, "the control token must open the route");
    assert!(allowed.json()["bindings"].is_array());

    // The guard runs before the JSON extractor, so a malformed body from an
    // unauthenticated caller is 401 rather than 422. 422 would describe the
    // body the endpoint expects to a caller that is not allowed to know.
    let refused_write = server.request("POST /v1/bindings HTTP/1.1", &[], body);
    assert_eq!(refused_write.status, 401, "writes must be token-gated too");

    let refused_malformed = server.request("POST /v1/bindings HTTP/1.1", &[], "not json");
    assert_eq!(
        refused_malformed.status, 401,
        "authorization must answer before the body extractor"
    );
}

#[test]
fn unknown_routes_are_not_served() {
    let server = Server::start(&[("JIT_GATEWAY_CONTROL_TOKEN", CONTROL_TOKEN)]);
    let response = server.request("GET /definitely-not-a-route HTTP/1.1", &[], "");
    assert_eq!(response.status, 404);
}

#[test]
fn sigterm_stops_the_server_cleanly() {
    let mut server = Server::start(&[("JIT_GATEWAY_CONTROL_TOKEN", CONTROL_TOKEN)]);
    let status = server
        .terminate()
        .expect("the server should exit after SIGTERM instead of hanging");
    assert!(
        status.success(),
        "graceful shutdown should exit successfully, got {status:?}"
    );
}
