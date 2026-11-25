//! Black-box fixtures for the Realtime WebSocket surface.
//!
//! `tests/blackbox.rs` covers the HTTP side. The socket is this service's main
//! interface and had no end-to-end test: these connect a real client, run the
//! Phoenix V2 handshake, join a topic, and assert that a broadcast reaches the
//! other subscriber — both from a peer client and from the control API.
//!
//! The WebSocket client is written by hand (RFC 6455 handshake + one masked text
//! frame each way) so this fixture adds no dependency. It does not verify
//! `Sec-WebSocket-Accept`; the server's own `axum` upgrade does the hashing, and
//! a fixture that reimplements SHA-1 to check it would test arithmetic, not this
//! service.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const READY_TIMEOUT: Duration = Duration::from_secs(15);
const FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const CONTROL_TOKEN: &str = "fixture-realtime-control-token";
const TENANT: &str = "fixture-tenant";
const TENANT_SECRET: &str = "fixture-tenant-jwt-secret-at-least-32-characters";

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
            if let Some(response) = self.http("GET", "/healthcheck", None, "") {
                if response.status == 200 {
                    return;
                }
            }
            sleep(Duration::from_millis(50));
        }
        panic!("realtime gateway did not answer /healthcheck within {READY_TIMEOUT:?}");
    }

    fn http(
        &self,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: &str,
    ) -> Option<HttpResponse> {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).ok()?;
        stream.set_read_timeout(Some(FRAME_TIMEOUT)).ok()?;
        let mut request =
            format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
        if let Some(token) = bearer {
            request.push_str(&format!("Authorization: Bearer {token}\r\n"));
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
        Some(HttpResponse::parse(&raw))
    }

    fn register_tenant(&self) {
        let body =
            format!(r#"{{"id":"{TENANT}","jwt_secret":"{TENANT_SECRET}","db_password":"unused"}}"#);
        let response = self
            .http("POST", "/api/tenants", Some(CONTROL_TOKEN), &body)
            .expect("registration should reach the server");
        assert_eq!(
            response.status, 201,
            "tenant registration failed: {}",
            response.body
        );
    }

    fn control_broadcast(&self, topic: &str, payload: &str) -> u16 {
        let body = format!(r#"{{"tenant_id":"{TENANT}","topic":"{topic}","payload":{payload}}}"#);
        let response = self
            .http("POST", "/api/broadcast", Some(CONTROL_TOKEN), &body)
            .expect("broadcast should reach the server");
        response.status
    }

    fn socket(&self, apikey: &str, tenant_ref: &str) -> Socket {
        Socket::connect(self.port, apikey, tenant_ref)
            .expect("the WebSocket upgrade should succeed")
    }

    fn try_socket(&self, apikey: &str, tenant_ref: &str) -> Option<Socket> {
        Socket::connect(self.port, apikey, tenant_ref)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct HttpResponse {
    status: u16,
    body: String,
}

impl HttpResponse {
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
}

/// A minimal RFC 6455 client: one handshake, text frames in and out.
struct Socket {
    stream: TcpStream,
}

impl Socket {
    fn connect(port: u16, apikey: &str, tenant_ref: &str) -> Option<Self> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
        stream.set_read_timeout(Some(FRAME_TIMEOUT)).ok()?;
        // 16 random-ish bytes are enough: the server only echoes the digest back.
        let key = base64::engine::general_purpose::STANDARD
            .encode(format!("supacloud-fixture-{}", std::process::id()));
        let request = format!(
            "GET /socket/websocket?apikey={apikey}&ref={tenant_ref} HTTP/1.1\r\n\
             Host: 127.0.0.1:{port}\r\n\
             Upgrade: websocket\r\n\
             Connection: Upgrade\r\n\
             Sec-WebSocket-Key: {key}\r\n\
             Sec-WebSocket-Version: 13\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).ok()?;

        let mut head = Vec::new();
        let mut byte = [0_u8; 1];
        while !head.ends_with(b"\r\n\r\n") {
            if stream.read(&mut byte).ok()? == 0 {
                return None;
            }
            head.push(byte[0]);
            if head.len() > 16 * 1024 {
                return None;
            }
        }
        let head = String::from_utf8_lossy(&head).into_owned();
        let status: u16 = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())?;
        if status != 101 {
            return None;
        }
        Some(Self { stream })
    }

    fn send_text(&mut self, payload: &str) {
        let bytes = payload.as_bytes();
        assert!(
            bytes.len() < 65_536,
            "fixture frames stay inside the 16-bit length form"
        );
        let mask = [0x11_u8, 0x22, 0x33, 0x44];
        let mut frame = Vec::with_capacity(bytes.len() + 8);
        frame.push(0x81); // FIN + text
        if bytes.len() < 126 {
            frame.push(0x80 | bytes.len() as u8); // masked + length
        } else {
            frame.push(0x80 | 126); // masked + 16-bit length follows
            frame.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        for (index, byte) in bytes.iter().enumerate() {
            frame.push(byte ^ mask[index % 4]);
        }
        self.stream
            .write_all(&frame)
            .expect("the client frame should be written");
    }

    /// Reads one text frame. Returns `None` on timeout or close.
    fn read_text(&mut self) -> Option<String> {
        let mut header = [0_u8; 2];
        self.stream.read_exact(&mut header).ok()?;
        let opcode = header[0] & 0x0f;
        let masked = header[1] & 0x80 != 0;
        let mut length = (header[1] & 0x7f) as usize;
        if length == 126 {
            let mut extended = [0_u8; 2];
            self.stream.read_exact(&mut extended).ok()?;
            length = u16::from_be_bytes(extended) as usize;
        } else if length == 127 {
            let mut extended = [0_u8; 8];
            self.stream.read_exact(&mut extended).ok()?;
            length = u64::from_be_bytes(extended) as usize;
        }
        if masked {
            let mut mask = [0_u8; 4];
            self.stream.read_exact(&mut mask).ok()?;
        }
        let mut payload = vec![0_u8; length];
        self.stream.read_exact(&mut payload).ok()?;
        match opcode {
            0x1 => Some(String::from_utf8_lossy(&payload).into_owned()),
            0x8 => None, // close
            // A ping from the server is not part of what this fixture asserts;
            // skip it and read the next frame.
            _ => Some(String::new()),
        }
    }

    /// Reads frames until `matches` accepts one, so unrelated presence diffs do
    /// not make an assertion order-dependent. Frames are parsed rather than
    /// string matched: the server's key order is not part of the contract.
    fn read_frame(
        &mut self,
        matches: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        for _ in 0..16 {
            let text = self.read_text()?;
            let frame: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("frame was not JSON ({error}): {text}"));
            if matches(&frame) {
                return Some(frame);
            }
        }
        None
    }

    fn join(&mut self, reference: &str, topic: &str) -> serde_json::Value {
        self.send_text(&format!(
            r#"[null,"{reference}","{topic}","phx_join",{{"config":{{}}}}]"#
        ));
        let reply = self
            .read_frame(|frame| frame[3] == "phx_reply")
            .expect("a join should be answered with phx_reply");
        assert_eq!(
            reply[4]["status"], "ok",
            "join was not acknowledged: {reply}"
        );
        reply
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

/// HS256 JWT with the tenant secret, the shape GoTrue issues for this project.
fn token(role: &str) -> String {
    let header =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(
        r#"{{"role":"{role}","sub":"fixture-user","exp":{}}}"#,
        now_seconds() + 600
    ));
    let signing_input = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(TENANT_SECRET.as_bytes())
        .expect("HMAC accepts any key length");
    mac.update(signing_input.as_bytes());
    let signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{signing_input}.{signature}")
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("the system clock is after the epoch")
        .as_secs()
}

#[test]
fn the_socket_refuses_an_unauthenticated_upgrade() {
    let server = Server::start();
    server.register_tenant();

    assert!(
        server.try_socket("", TENANT).is_none(),
        "a missing apikey must not upgrade"
    );
    assert!(
        server.try_socket("not-a-jwt", TENANT).is_none(),
        "a malformed apikey must not upgrade"
    );
    assert!(
        server
            .try_socket(
                &token_with("authenticated", "another-secret-entirely-0123456789"),
                TENANT
            )
            .is_none(),
        "a token signed with the wrong secret must not upgrade"
    );
    assert!(
        server
            .try_socket(&token("authenticated"), "unknown-tenant")
            .is_none(),
        "an unknown tenant reference must not upgrade"
    );
}

#[test]
fn heartbeat_and_join_are_answered_on_the_socket() {
    let server = Server::start();
    server.register_tenant();
    let mut socket = server.socket(&token("authenticated"), TENANT);

    socket.send_text(r#"[null,"1","phoenix","heartbeat",{}]"#);
    let heartbeat = socket
        .read_frame(|frame| frame[2] == "phoenix")
        .expect("a heartbeat should be answered");
    assert_eq!(heartbeat[3], "phx_reply");
    assert_eq!(heartbeat[4]["status"], "ok");
    assert_eq!(heartbeat[1], "1", "the reply must carry the request ref");

    socket.join("2", "room:fixture");
}

#[test]
fn a_broadcast_from_one_client_reaches_the_other() {
    let server = Server::start();
    server.register_tenant();
    let apikey = token("authenticated");
    let mut listener = server.socket(&apikey, TENANT);
    listener.join("1", "room:fanout");
    let mut sender = server.socket(&apikey, TENANT);
    sender.join("1", "room:fanout");

    sender.send_text(
        r#"[null,"2","room:fanout","broadcast",{"type":"broadcast","event":"message","payload":{"hello":"world"}}]"#,
    );
    let delivered = listener
        .read_frame(|frame| frame[3] == "broadcast")
        .expect("the peer should receive the broadcast");
    assert_eq!(
        delivered[2], "room:fanout",
        "broadcast went to the wrong topic"
    );
    assert_eq!(delivered[4]["event"], "message");
    assert_eq!(delivered[4]["payload"]["hello"], "world");
}

#[test]
fn the_control_api_reaches_every_subscriber() {
    let server = Server::start();
    server.register_tenant();
    let apikey = token("authenticated");
    let mut first = server.socket(&apikey, TENANT);
    first.join("1", "room:control");
    let mut second = server.socket(&apikey, TENANT);
    second.join("1", "room:control");

    let status = server.control_broadcast("room:control", r#"{"from":"control-api"}"#);
    assert_eq!(status, 200);

    for (name, socket) in [("first", &mut first), ("second", &mut second)] {
        let delivered = socket
            .read_frame(|frame| frame[3] == "broadcast")
            .unwrap_or_else(|| panic!("{name} subscriber should receive the control broadcast"));
        assert_eq!(delivered[2], "room:control", "{name}: {delivered}");
        assert_eq!(delivered[4]["from"], "control-api", "{name}: {delivered}");
    }
}

#[test]
fn postgres_changes_subscriptions_require_a_privileged_role() {
    // Documented behaviour: per-tenant RLS filtering for CDC is not implemented,
    // so an `authenticated` client asking for postgres_changes must be refused
    // rather than silently receiving another tenant's rows.
    let server = Server::start();
    server.register_tenant();
    let mut socket = server.socket(&token("authenticated"), TENANT);

    socket.send_text(
        r#"[null,"1","realtime:public:todos","phx_join",{"config":{"postgres_changes":[{"event":"*","schema":"public","table":"todos"}]}}]"#,
    );
    let reply = socket
        .read_frame(|frame| frame[3] == "phx_reply")
        .expect("the join should be answered");
    assert_eq!(
        reply[4]["status"], "error",
        "an unprivileged postgres_changes join must be refused: {reply}"
    );
    let reason = reply[4]["response"]["reason"]
        .as_str()
        .unwrap_or_else(|| panic!("the refusal should carry a reason: {reply}"));
    assert!(
        reason.contains("postgres_changes requires service_role"),
        "unexpected refusal reason: {reason}"
    );
}

fn token_with(role: &str, secret: &str) -> String {
    let header =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(
        r#"{{"role":"{role}","sub":"fixture-user","exp":{}}}"#,
        now_seconds() + 600
    ));
    let signing_input = format!("{header}.{payload}");
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(signing_input.as_bytes());
    let signature =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{signing_input}.{signature}")
}
