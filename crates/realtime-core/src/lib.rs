//! Embeddable SupaCloud Realtime protocol core.
//!
//! This crate intentionally has no Tokio, Axum, PostgreSQL or WebSocket
//! dependency. It owns only the parts of Realtime that must stay identical
//! between the standalone Rust gateway and the Bun-based Lite runtime:
//! Phoenix frame codec, `postgres_changes` matching, presence bookkeeping and
//! channel/broadcast state transitions.
//!
//! The host (Rust gateway or Bun over `bun:ffi`) supplies the transport, JWT
//! verification, database access and RLS authorization results.

pub mod ffi;
pub mod filter;
pub mod presence;
pub mod protocol;
pub mod session;

pub use ffi::ABI_VERSION;
pub use filter::ColumnFilter;
pub use presence::PresenceManager;
pub use protocol::{Frame, Vsn};
pub use session::{Effect, Outcome, OutgoingFrame, Session};
