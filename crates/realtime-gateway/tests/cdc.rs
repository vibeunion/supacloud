//! Black-box fixtures for the Postgres CDC delivery path.
//!
//! `tests/websocket.rs` proves the socket and the authorization refusal. What it
//! could not prove is that a table write on a real database reaches a subscribed
//! client with the right row, and only when the subscription asks for it.
//! `PostgresListenerManager` had no end-to-end test at all, which is
//! uncomfortable for the component whose failure mode is another tenant's rows
//! arriving on a socket.
//!
//! The gateway consumes the tenant's `wal2json` replication slot by calling
//! `realtime.list_changes`, which applies `realtime.apply_rls` to the
//! subscriptions stored in `realtime.subscription`. The fixture therefore
//! installs the pinned Realtime 2.150.0 tenant schema, starts a cluster with
//! `wal_level=logical`, creates the publication and a table, registers a tenant,
//! subscribes over the socket, and writes rows.
//!
//! Requires the PostgreSQL server binaries **and** the `wal2json` output plugin.
//! The binaries are found via `POSTGRES_BIN`, then `pg_config --bindir`, then the
//! usual installation prefixes. When none of those exist the test prints why it
//! did nothing and returns, so a developer without PostgreSQL does not see a red
//! suite. When `POSTGRES_BIN` is set but the binaries or the plugin are missing,
//! or when nothing is found on CI, the test fails: CI must not skip this
//! silently.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const FRAME_TIMEOUT: Duration = Duration::from_secs(15);
const CONTROL_TOKEN: &str = "fixture-realtime-control-token";
const TENANT_SECRET: &str = "fixture-tenant-jwt-secret-at-least-32-characters";
const PUBLICATION: &str = "supabase_realtime";

// ---------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------

struct Postgres {
    data_dir: PathBuf,
    bin_dir: PathBuf,
    port: u16,
}

impl Postgres {
    /// Returns `None` when no PostgreSQL installation can be found, so the suite
    /// stays green for a developer without one.
    fn start() -> Option<Self> {
        let bin_dir = match std::env::var("POSTGRES_BIN") {
            Ok(value) if !value.trim().is_empty() => {
                let bin_dir = PathBuf::from(value);
                for binary in ["initdb", "pg_ctl", "psql"] {
                    assert!(
                        bin_dir.join(binary).is_file(),
                        "POSTGRES_BIN is set but {binary} is missing from {}",
                        bin_dir.display()
                    );
                }
                bin_dir
            }
            _ => match discover_postgres_bin() {
                Some(bin_dir) => bin_dir,
                None => {
                    assert!(
                        std::env::var_os("CI").is_none(),
                        "CI must run the CDC fixtures, but no PostgreSQL installation was found"
                    );
                    eprintln!(
                        "skipping the CDC fixtures: set POSTGRES_BIN to the directory holding initdb and pg_ctl"
                    );
                    return None;
                }
            },
        };

        // `initdb` and the port handshake are serialized: `free_port` closes its
        // listener before PostgreSQL binds, so two fixtures starting at the same
        // time can be handed the same port. One start at a time removes the race,
        // and each `initdb` takes a fraction of a second.
        static START_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _start_guard = START_LOCK.lock().unwrap_or_else(|error| error.into_inner());

        // A short base directory on purpose: PostgreSQL's Unix socket path is
        // limited to 103 bytes, and the platform temp directory on macOS
        // (`/var/folders/…`) is long enough to exceed it.
        let base = std::path::Path::new("/tmp");
        let base = if base.is_dir() {
            base.to_path_buf()
        } else {
            std::env::temp_dir()
        };
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let data_dir = base.join(format!(
            "sc-cdc-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&data_dir).expect("the temporary data directory should be created");

        run(
            &bin_dir.join("initdb"),
            &[
                "-D",
                data_dir.to_str().expect("utf-8 path"),
                "--username=postgres",
                "--auth=trust",
                "--no-sync",
            ],
        );
        let port = free_port();
        run(
            &bin_dir.join("pg_ctl"),
            &[
                "-D",
                data_dir.to_str().expect("utf-8 path"),
                "-l",
                data_dir.join("server.log").to_str().expect("utf-8 path"),
                "-w",
                "start",
                "-o",
                &format!(
                    "-k {} -p {port} -c listen_addresses=127.0.0.1 -c timezone=UTC \
                     -c wal_level=logical -c max_replication_slots=8 -c max_wal_senders=8",
                    data_dir.display()
                ),
            ],
        );
        let postgres = Self {
            data_dir,
            bin_dir,
            port,
        };
        postgres.allow_wal2json();
        postgres.assert_wal2json();
        Some(postgres)
    }

    /// PostgreSQL 17 and later accept an output plugin only when it is listed in
    /// `output_plugin_libraries`. Older releases have no such setting and reject
    /// the statement, which is why the failure is ignored.
    fn allow_wal2json(&self) {
        let _ = self.try_psql(
            "postgres",
            "ALTER SYSTEM SET output_plugin_libraries = 'wal2json'",
        );
        let _ = self.try_psql("postgres", "SELECT pg_reload_conf()");
    }

    /// Creating a slot is the only honest availability check: `wal2json` is an
    /// output plugin, not an extension, so `pg_available_extensions` cannot see
    /// it. A missing plugin fails here instead of looking like a delivery bug.
    fn assert_wal2json(&self) {
        let created = self.try_psql(
            "postgres",
            "SELECT pg_create_logical_replication_slot('wal2json_probe', 'wal2json')",
        );
        match created {
            Ok(_) => {
                self.psql(
                    "postgres",
                    "SELECT pg_drop_replication_slot('wal2json_probe')",
                );
            }
            Err(error) => panic!(
                "the CDC fixtures need the wal2json output plugin in {}: {error}",
                self.bin_dir.display()
            ),
        }
    }

    fn psql(&self, database: &str, sql: &str) -> String {
        self.try_psql(database, sql)
            .unwrap_or_else(|error| panic!("psql failed in {database} ({sql}): {error}"))
    }

    fn psql_file(&self, database: &str, path: &Path) {
        let output = Command::new(self.bin_dir.join("psql"))
            .args([
                "-h",
                "127.0.0.1",
                "-p",
                &self.port.to_string(),
                "-U",
                "postgres",
                "-d",
                database,
                "-v",
                "ON_ERROR_STOP=1",
                "-f",
                path.to_str().expect("utf-8 schema path"),
            ])
            .output()
            .unwrap_or_else(|error| panic!("psql did not run for {}: {error}", path.display()));
        if !output.status.success() {
            panic!(
                "psql failed applying {} in {database}: {}",
                path.display(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
    }

    fn try_psql(&self, database: &str, sql: &str) -> Result<String, String> {
        let output = Command::new(self.bin_dir.join("psql"))
            .args([
                "-h",
                "127.0.0.1",
                "-p",
                &self.port.to_string(),
                "-U",
                "postgres",
                "-d",
                database,
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
                "-c",
                sql,
            ])
            .output()
            .map_err(|error| format!("psql did not run: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    }

    fn create_database(&self, name: &str) {
        self.psql("postgres", &format!(r#"CREATE DATABASE "{name}""#));
    }

    /// The pinned Realtime 2.150.0 tenant schema (`realtime.subscription`,
    /// `realtime.apply_rls`, `realtime.list_changes`). The gateway refuses a
    /// `postgres_changes` join until those objects exist, and a missing file
    /// fails the fixture.
    fn install_realtime_schema(&self, database: &str) {
        self.psql(
            database,
            "DO $$ BEGIN
               IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
                 CREATE ROLE supabase_admin NOLOGIN;
               END IF;
               IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
                 CREATE ROLE supabase_realtime_admin NOLOGIN;
               END IF;
               IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                 CREATE ROLE anon NOLOGIN NOINHERIT;
               END IF;
               IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                 CREATE ROLE authenticated NOLOGIN NOINHERIT;
               END IF;
               IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
                 CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
               END IF;
             END $$;
             GRANT supabase_realtime_admin TO supabase_admin WITH INHERIT TRUE, SET TRUE;
             GRANT anon, authenticated, service_role TO supabase_admin WITH INHERIT FALSE, SET TRUE;
             GRANT supabase_admin, supabase_realtime_admin, anon, authenticated, service_role TO postgres",
        );
        // One artifact, two consumers: the Management API applies these exact
        // bytes during tenant bootstrap, and this fixture installs them the same
        // way a fresh database gets them. A private copy here would be able to
        // drift into proving something production does not have.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/management-api/src/db/realtime-tenant-schema/2.150.0");
        let order = std::fs::read_to_string(root.join("order.txt"))
            .expect("the pinned Realtime schema order should be present");
        for relative in order.lines().map(str::trim).filter(|line| !line.is_empty()) {
            self.psql_file(database, &root.join(relative));
        }
    }

    /// The two tables every scenario uses: one published, one deliberately not.
    fn create_tables(&self, database: &str) {
        self.install_realtime_schema(database);
        self.psql(
            database,
            "CREATE TABLE todos (id serial primary key, task text, done boolean); \
             CREATE TABLE notes (id serial primary key, body text); \
             GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role; \
             GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role",
        );
    }

    fn publish(&self, database: &str, tables: &[&str]) {
        self.psql(database, &format!("CREATE PUBLICATION {PUBLICATION}"));
        for table in tables {
            self.psql(
                database,
                &format!("ALTER PUBLICATION {PUBLICATION} ADD TABLE {table}"),
            );
        }
    }

    fn insert_todo(&self, database: &str, task: &str) -> String {
        self.psql(
            database,
            &format!("INSERT INTO todos (task, done) VALUES ('{task}', false)"),
        )
    }

    /// The slot exists only once the gateway has connected, adopted or created
    /// it, so a write before that point would be delivered from a slot that does
    /// not exist yet.
    fn wait_for_slot(&self, database: &str) -> String {
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            let slot = self.psql(
                database,
                "SELECT coalesce((SELECT slot_name FROM pg_replication_slots \
                 WHERE database = current_database() AND plugin = 'wal2json' \
                 ORDER BY slot_name LIMIT 1), '')",
            );
            if !slot.is_empty() {
                return slot;
            }
            assert!(
                Instant::now() < deadline,
                "the gateway did not open a wal2json slot on {database} within {READY_TIMEOUT:?}"
            );
            sleep(Duration::from_millis(50));
        }
    }

    /// The channel the previous implementation listened on. Nothing publishes it
    /// any more, and a client must not receive it.
    fn notify_legacy_channel(&self, database: &str) {
        self.psql(
            database,
            r#"SELECT pg_notify('realtime_changes', '{"schema":"public","table":"todos","type":"INSERT","record":{"id":999,"task":"notify"}}')"#,
        );
    }
}

impl Drop for Postgres {
    fn drop(&mut self) {
        let _ = Command::new(self.bin_dir.join("pg_ctl"))
            .args([
                "-D",
                self.data_dir.to_str().unwrap_or_default(),
                "-m",
                "immediate",
                "stop",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = std::fs::remove_dir_all(&self.data_dir);
    }
}

fn run(binary: &Path, args: &[&str]) {
    let output = Command::new(binary)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("{} could not run: {error}", binary.display()));
    assert!(
        output.status.success(),
        "{} {args:?} failed: {}",
        binary.display(),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// Looks for the server binaries where PostgreSQL installers put them, so a
/// plain `cargo test` works without exporting anything.
fn discover_postgres_bin() -> Option<PathBuf> {
    if let Ok(output) = Command::new("pg_config").arg("--bindir").output() {
        if output.status.success() {
            let dir = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
            if dir.join("initdb").is_file() {
                return Some(dir);
            }
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    for prefix in ["/usr/lib/postgresql", "/opt/homebrew/opt"] {
        let Ok(entries) = std::fs::read_dir(prefix) else {
            continue;
        };
        for entry in entries.flatten() {
            candidates.push(entry.path().join("bin"));
        }
    }
    candidates
        .into_iter()
        .find(|dir| dir.join("initdb").is_file())
}

// ---------------------------------------------------------------------------
// Realtime gateway
// ---------------------------------------------------------------------------

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
                if response.0 == 200 {
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
    ) -> Option<(u16, String)> {
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
        let text = String::from_utf8_lossy(&raw).into_owned();
        let (head, response_body) = text.split_once("\r\n\r\n").unwrap_or((text.as_str(), ""));
        let status = head
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())?;
        Some((status, response_body.to_owned()))
    }

    fn register_tenant(&self, tenant: &str, postgres: &Postgres) {
        self.register_tenant_in(tenant, postgres, "postgres");
    }

    fn register_tenant_in(&self, tenant: &str, postgres: &Postgres, database: &str) {
        // The registration payload is the Management API's: the CDC settings
        // travel the same way they reach the Elixir Realtime container.
        let body = format!(
            r#"{{"id":"{tenant}","jwt_secret":"{TENANT_SECRET}","db_host":"127.0.0.1","db_port":{},"db_name":"{database}","db_user":"postgres","db_password":"","publication":"{PUBLICATION}","poll_interval_ms":50}}"#,
            postgres.port
        );
        let (status, response) = self
            .http("POST", "/api/tenants", Some(CONTROL_TOKEN), &body)
            .expect("registration should reach the server");
        assert_eq!(status, 201, "tenant registration failed: {response}");
    }

    fn socket(&self, apikey: &str, tenant: &str) -> Socket {
        Socket::connect(self.port, apikey, tenant).expect("the WebSocket upgrade should succeed")
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct Socket {
    stream: TcpStream,
}

impl Socket {
    fn connect(port: u16, apikey: &str, tenant: &str) -> Option<Self> {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
        stream.set_read_timeout(Some(FRAME_TIMEOUT)).ok()?;
        let key = base64::engine::general_purpose::STANDARD
            .encode(format!("supacloud-cdc-fixture-{}", std::process::id()));
        let request = format!(
            "GET /socket/websocket?apikey={apikey}&ref={tenant} HTTP/1.1\r\n\
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
            "fixture frames stay in the 16-bit form"
        );
        let mask = [0x51_u8, 0x62, 0x73, 0x84];
        let mut frame = Vec::with_capacity(bytes.len() + 8);
        frame.push(0x81);
        if bytes.len() < 126 {
            frame.push(0x80 | bytes.len() as u8);
        } else {
            frame.push(0x80 | 126);
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
            0x8 => None,
            _ => Some(String::new()),
        }
    }

    fn read_frame(
        &mut self,
        matches: impl Fn(&serde_json::Value) -> bool,
    ) -> Option<serde_json::Value> {
        for _ in 0..32 {
            let text = self.read_text()?;
            let frame: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|error| panic!("frame was not JSON ({error}): {text}"));
            if matches(&frame) {
                return Some(frame);
            }
        }
        None
    }

    fn set_read_timeout(&mut self, timeout: Duration) {
        self.stream
            .set_read_timeout(Some(timeout))
            .expect("the socket read timeout should be settable");
    }

    /// Waits for the next frame the matcher accepts.
    ///
    /// The change stream is a slot, not a broadcast: a write that happens after
    /// the slot exists is retained until the gateway reads it, so there is
    /// nothing to re-send here.
    fn expect_event(&mut self, matches: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
        self.set_read_timeout(FRAME_TIMEOUT);
        self.read_frame(matches)
            .expect("the subscribed client never received the event")
    }

    /// Subscribes and requires the join to be accepted. A refused join means the
    /// subscription row was not stored, so nothing may be delivered.
    fn subscribe(&mut self, topic: &str, subscription: &str) {
        self.send_text(&format!(
            r#"[null,"1","{topic}","phx_join",{{"config":{{"postgres_changes":[{subscription}]}}}}]"#
        ));
        let reply = self
            .read_frame(|frame| frame[3] == "phx_reply")
            .expect("the join should be answered");
        assert_eq!(
            reply[4]["status"], "ok",
            "a CDC join should be accepted: {reply}"
        );
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

fn token(role: &str) -> String {
    token_for(role, "fixture-user")
}

fn token_for(role: &str, sub: &str) -> String {
    let header =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(format!(
        r#"{{"role":"{role}","sub":"{sub}","exp":{}}}"#,
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
fn an_insert_reaches_a_service_role_subscriber() {
    let Some(postgres) = Postgres::start() else {
        return;
    };
    postgres.create_tables("postgres");
    postgres.publish("postgres", &["todos"]);
    let server = Server::start();
    server.register_tenant("cdc-insert", &postgres);
    postgres.wait_for_slot("postgres");

    let mut socket = server.socket(&token("service_role"), "cdc-insert");
    socket.subscribe(
        "realtime:public:todos",
        r#"{"id":"sub-insert","event":"INSERT","schema":"public","table":"todos"}"#,
    );

    // The previous implementation listened on this channel. Nothing publishes it
    // any more, so it must not be able to satisfy the assertion below.
    postgres.notify_legacy_channel("postgres");
    postgres.insert_todo("postgres", "write the fixture");

    let delivered = socket.expect_event(is_postgres_change);
    assert_eq!(delivered[2], "realtime:public:todos");
    assert_eq!(delivered[4]["data"]["schema"], "public");
    assert_eq!(delivered[4]["data"]["table"], "todos");
    assert_eq!(delivered[4]["data"]["type"], "INSERT");
    assert_eq!(delivered[4]["data"]["record"]["task"], "write the fixture");
    assert_eq!(delivered[4]["data"]["record"]["done"], false);
    assert_eq!(
        delivered[4]["data"]["columns"],
        serde_json::json!([
            {"name": "id", "type": "int4"},
            {"name": "task", "type": "text"},
            {"name": "done", "type": "bool"}
        ]),
        "the client needs the column list to build its typed rows"
    );
    assert_eq!(
        delivered[4]["ids"],
        serde_json::json!(["sub-insert"]),
        "the delivery must name the subscription that matched"
    );
    let timestamp = delivered[4]["data"]["commit_timestamp"]
        .as_str()
        .expect("a change carries its commit timestamp");
    assert!(
        timestamp.contains('T') && timestamp.ends_with('Z'),
        "commit_timestamp should be the UTC value realtime.apply_rls emits: {timestamp}"
    );
}

#[test]
fn updates_and_deletes_carry_the_row_identity() {
    let Some(postgres) = Postgres::start() else {
        return;
    };
    postgres.create_tables("postgres");
    postgres.publish("postgres", &["todos"]);
    let server = Server::start();
    server.register_tenant("cdc-mutations", &postgres);
    postgres.wait_for_slot("postgres");

    let mut socket = server.socket(&token("service_role"), "cdc-mutations");
    socket.subscribe(
        "realtime:public:todos",
        r#"{"id":"sub-mutations","event":"*","schema":"public","table":"todos"}"#,
    );

    postgres.insert_todo("postgres", "first");
    let inserted = socket.expect_event(is_postgres_change);
    assert_eq!(inserted[4]["data"]["type"], "INSERT");
    let id = inserted[4]["data"]["record"]["id"].clone();
    assert_eq!(
        inserted[4]["data"]["old_record"],
        serde_json::Value::Null,
        "an insert has no previous row"
    );

    postgres.psql(
        "postgres",
        &format!("UPDATE todos SET task = 'second', done = true WHERE id = {id}"),
    );
    let updated = socket.expect_event(is_postgres_change);
    assert_eq!(updated[4]["data"]["type"], "UPDATE");
    assert_eq!(updated[4]["data"]["record"]["task"], "second");
    assert_eq!(
        updated[4]["data"]["old_record"]["id"], id,
        "an update has to name the row it replaced: {updated}"
    );

    postgres.psql("postgres", &format!("DELETE FROM todos WHERE id = {id}"));
    let deleted = socket.expect_event(is_postgres_change);
    assert_eq!(deleted[4]["data"]["type"], "DELETE");
    assert!(
        deleted[4]["data"]["record"].is_null(),
        "realtime.apply_rls omits the new row on DELETE: {deleted}"
    );
    assert_eq!(
        deleted[4]["data"]["old_record"]["id"], id,
        "a delete has to name the row it removed: {deleted}"
    );
}

#[test]
fn a_subscriber_only_receives_the_table_and_event_it_asked_for() {
    let Some(postgres) = Postgres::start() else {
        return;
    };
    postgres.create_tables("postgres");
    // `notes` exists but is not a publication member, so no change to it is even
    // decoded.
    postgres.publish("postgres", &["todos"]);
    let server = Server::start();
    server.register_tenant("cdc-scope", &postgres);
    postgres.wait_for_slot("postgres");

    let mut socket = server.socket(&token("service_role"), "cdc-scope");
    socket.subscribe(
        "realtime:public:todos",
        r#"{"id":"sub-scope","event":"INSERT","schema":"public","table":"todos"}"#,
    );
    socket.set_read_timeout(Duration::from_millis(400));

    postgres.psql(
        "postgres",
        "INSERT INTO notes (body) VALUES ('unpublished')",
    );
    postgres.psql("postgres", "UPDATE todos SET done = true");
    assert!(
        socket.read_frame(is_postgres_change).is_none(),
        "a non-member table or an unsubscribed event was delivered"
    );

    socket.set_read_timeout(FRAME_TIMEOUT);
    postgres.insert_todo("postgres", "right event");
    let delivered = socket.expect_event(is_postgres_change);
    assert_eq!(delivered[4]["data"]["type"], "INSERT");
    assert_eq!(
        delivered[4]["data"]["record"]["task"], "right event",
        "an earlier event was delivered: {delivered}"
    );
}

#[test]
fn a_column_filter_limits_delivery_to_matching_rows() {
    let Some(postgres) = Postgres::start() else {
        return;
    };
    postgres.create_tables("postgres");
    postgres.publish("postgres", &["todos"]);
    let server = Server::start();
    server.register_tenant("cdc-filter", &postgres);
    postgres.wait_for_slot("postgres");

    let mut socket = server.socket(&token("service_role"), "cdc-filter");
    socket.subscribe(
        "realtime:public:todos",
        r#"{"id":"sub-filter","event":"INSERT","schema":"public","table":"todos","filter":"task=eq.keep"}"#,
    );
    socket.set_read_timeout(Duration::from_millis(400));

    postgres.insert_todo("postgres", "skip");
    assert!(
        socket.read_frame(is_postgres_change).is_none(),
        "the filter let a non-matching row through"
    );

    socket.set_read_timeout(FRAME_TIMEOUT);
    postgres.insert_todo("postgres", "keep");
    let delivered = socket.expect_event(is_postgres_change);
    assert_eq!(delivered[4]["data"]["record"]["task"], "keep");
    assert_eq!(delivered[4]["ids"], serde_json::json!(["sub-filter"]));
}

#[test]
fn one_tenant_database_does_not_reach_another_tenant() {
    let Some(postgres) = Postgres::start() else {
        return;
    };
    for database in ["tenant_owner", "tenant_other"] {
        postgres.create_database(database);
        postgres.create_tables(database);
        postgres.publish(database, &["todos"]);
    }
    let server = Server::start();
    server.register_tenant_in("cdc-owner", &postgres, "tenant_owner");
    server.register_tenant_in("cdc-other", &postgres, "tenant_other");
    postgres.wait_for_slot("tenant_owner");
    postgres.wait_for_slot("tenant_other");

    let mut owner = server.socket(&token("service_role"), "cdc-owner");
    owner.subscribe(
        "realtime:public:todos",
        r#"{"id":"sub-owner","event":"INSERT","schema":"public","table":"todos"}"#,
    );
    // The other tenant subscribes to the same topic name in its own database.
    let mut other = server.socket(&token("service_role"), "cdc-other");
    other.subscribe(
        "realtime:public:todos",
        r#"{"id":"sub-other","event":"INSERT","schema":"public","table":"todos"}"#,
    );
    other.set_read_timeout(Duration::from_millis(600));

    postgres.insert_todo("tenant_owner", "only the owner may see this");
    let delivered = owner.expect_event(is_postgres_change);
    assert_eq!(
        delivered[4]["data"]["record"]["task"],
        "only the owner may see this"
    );
    assert_eq!(delivered[4]["ids"], serde_json::json!(["sub-owner"]));
    assert!(
        other.read_frame(is_postgres_change).is_none(),
        "tenant isolation failed: another tenant received the row"
    );
}

fn is_postgres_change(frame: &serde_json::Value) -> bool {
    frame[3] == "postgres_changes"
}

#[test]
fn row_level_security_hides_a_row_from_another_role() {
    let Some(postgres) = Postgres::start() else {
        return;
    };
    postgres.create_tables("postgres");
    postgres.psql(
        "postgres",
        "CREATE TABLE secrets (
            id serial primary key,
            body text,
            owner_id text,
            visibility text
         );
         ALTER TABLE secrets ENABLE ROW LEVEL SECURITY;
         GRANT SELECT ON secrets TO anon, authenticated, service_role;
         CREATE POLICY anon_sees_public ON secrets
           FOR SELECT TO anon
           USING (visibility = 'public');
         CREATE POLICY authenticated_sees_own ON secrets
           FOR SELECT TO authenticated
           USING (owner_id = current_setting('request.jwt.claims', true)::json->>'sub')",
    );
    postgres.publish("postgres", &["secrets"]);
    let server = Server::start();
    server.register_tenant("cdc-rls", &postgres);
    postgres.wait_for_slot("postgres");

    let mut alice = server.socket(&token_for("authenticated", "alice"), "cdc-rls");
    alice.subscribe(
        "realtime:public:secrets",
        r#"{"id":"alice","event":"INSERT","schema":"public","table":"secrets"}"#,
    );
    let mut bob = server.socket(&token_for("authenticated", "bob"), "cdc-rls");
    bob.subscribe(
        "realtime:public:secrets",
        r#"{"id":"bob","event":"INSERT","schema":"public","table":"secrets"}"#,
    );
    let mut anon = server.socket(&token_for("anon", "anon-user"), "cdc-rls");
    anon.subscribe(
        "realtime:public:secrets",
        r#"{"id":"anon","event":"INSERT","schema":"public","table":"secrets"}"#,
    );
    let mut service = server.socket(&token("service_role"), "cdc-rls");
    service.subscribe(
        "realtime:public:secrets",
        r#"{"id":"service","event":"INSERT","schema":"public","table":"secrets"}"#,
    );

    postgres.psql(
        "postgres",
        "INSERT INTO secrets (body, owner_id, visibility) VALUES ('alice-private', 'alice', 'private')",
    );
    let alice_private = alice.expect_event(is_postgres_change);
    assert_eq!(alice_private[4]["data"]["record"]["body"], "alice-private");
    assert_eq!(alice_private[4]["ids"], serde_json::json!(["alice"]));
    let service_private = service.expect_event(is_postgres_change);
    assert_eq!(
        service_private[4]["data"]["record"]["body"],
        "alice-private"
    );
    assert_eq!(service_private[4]["ids"], serde_json::json!(["service"]));

    bob.set_read_timeout(Duration::from_millis(400));
    anon.set_read_timeout(Duration::from_millis(400));
    assert!(
        bob.read_frame(is_postgres_change).is_none(),
        "authenticated bob saw a row owned by alice"
    );
    assert!(
        anon.read_frame(is_postgres_change).is_none(),
        "anon saw a private row"
    );

    bob.set_read_timeout(FRAME_TIMEOUT);
    anon.set_read_timeout(FRAME_TIMEOUT);
    alice.set_read_timeout(FRAME_TIMEOUT);
    service.set_read_timeout(FRAME_TIMEOUT);
    postgres.psql(
        "postgres",
        "INSERT INTO secrets (body, owner_id, visibility) VALUES ('posted', 'alice', 'public')",
    );
    let alice_public = alice.expect_event(is_postgres_change);
    assert_eq!(alice_public[4]["data"]["record"]["body"], "posted");
    let anon_public = anon.expect_event(is_postgres_change);
    assert_eq!(anon_public[4]["data"]["record"]["body"], "posted");
    assert_eq!(anon_public[4]["ids"], serde_json::json!(["anon"]));
    let service_public = service.expect_event(is_postgres_change);
    assert_eq!(service_public[4]["ids"], serde_json::json!(["service"]));
    bob.set_read_timeout(Duration::from_millis(400));
    assert!(
        bob.read_frame(is_postgres_change).is_none(),
        "authenticated bob saw alice's public row"
    );
}
