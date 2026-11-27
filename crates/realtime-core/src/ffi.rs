//! C ABI for embedding the Realtime core.
//!
//! The contract is deliberately byte-oriented: callers pass UTF-8 JSON and get
//! back UTF-8 JSON. No Rust type, allocator, thread or async runtime crosses the
//! boundary, so the same `.so` / `.dylib` / `.dll` can be loaded with `bun:ffi`
//! or any other C FFI consumer.
//!
//! ```text
//! ScSession *session = sc_realtime_core_new(NULL, 0);
//! ScBuffer  *reply   = sc_realtime_core_handle(session, req_ptr, req_len);
//! const uint8_t *out = sc_realtime_core_buffer_data(reply);
//! size_t          n  = sc_realtime_core_buffer_len(reply);
//! sc_realtime_core_buffer_free(reply);
//! sc_realtime_core_free(session);
//! ```
//!
//! Every function validates pointers and never unwinds across the boundary.

use crate::session::Session;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::slice;
use std::sync::Mutex;

/// Bumped whenever the ABI or the JSON command/response schema changes.
///
/// Optional request fields an older core simply ignores (and that only affect
/// performance, not behaviour) do not need a bump; `record_ref` is one, so a
/// staged core from before it still produces correct frames, just slower.
pub const ABI_VERSION: u32 = 1;

/// Owned byte buffer returned to the host. Must be released with
/// [`sc_realtime_core_buffer_free`].
#[repr(C)]
pub struct ScBuffer {
    data: *mut u8,
    len: usize,
    cap: usize,
}

impl ScBuffer {
    fn from_vec(bytes: Vec<u8>) -> *mut ScBuffer {
        let mut bytes = bytes;
        let buffer = ScBuffer {
            data: bytes.as_mut_ptr(),
            len: bytes.len(),
            cap: bytes.capacity(),
        };
        std::mem::forget(bytes);
        Box::into_raw(Box::new(buffer))
    }

    fn into_vec(self) -> Vec<u8> {
        if self.data.is_null() || self.cap == 0 {
            return Vec::new();
        }
        // SAFETY: `data`/`len`/`cap` came from `Vec::into_raw_parts`-equivalent
        // bookkeeping in `from_vec`, and the buffer is freed exactly once.
        unsafe { Vec::from_raw_parts(self.data, self.len, self.cap) }
    }
}

static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn set_last_error(message: impl Into<String>) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = Some(message.into());
    }
}

fn take_last_error() -> Option<String> {
    LAST_ERROR.lock().ok().and_then(|mut slot| slot.take())
}

unsafe fn request_bytes<'a>(data: *const u8, len: usize) -> Result<&'a [u8], String> {
    if len == 0 {
        return Ok(&[]);
    }
    if data.is_null() {
        return Err("request pointer is null".into());
    }
    Ok(slice::from_raw_parts(data, len))
}

unsafe fn request_str<'a>(data: *const u8, len: usize) -> Result<&'a str, String> {
    let bytes = request_bytes(data, len)?;
    std::str::from_utf8(bytes).map_err(|e| format!("request is not UTF-8: {e}"))
}

/// Returns the ABI version the loaded library was built with.
#[no_mangle]
pub extern "C" fn sc_realtime_core_abi_version() -> u32 {
    ABI_VERSION
}

/// Create an isolated core session.
///
/// `config` is reserved for forward-compatible limits and is currently parsed
/// only to reject malformed JSON. Returns null on failure; consult
/// [`sc_realtime_core_last_error`].
///
/// # Safety
/// `config` must point to `config_len` readable bytes or be null with length 0.
#[no_mangle]
pub unsafe extern "C" fn sc_realtime_core_new(
    config: *const u8,
    config_len: usize,
) -> *mut Session {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if config_len > 0 {
            let raw = request_str(config, config_len)?;
            if !raw.trim().is_empty() {
                serde_json::from_str::<serde_json::Value>(raw)
                    .map_err(|e| format!("invalid core config: {e}"))?;
            }
        }
        Ok::<_, String>(Box::into_raw(Box::new(Session::new())))
    }));

    match result {
        Ok(Ok(session)) => session,
        Ok(Err(message)) => {
            set_last_error(message);
            ptr::null_mut()
        }
        Err(_) => {
            set_last_error("panic while creating realtime core session");
            ptr::null_mut()
        }
    }
}

/// Release a session created by [`sc_realtime_core_new`].
///
/// # Safety
/// `session` must be null or a pointer returned by `sc_realtime_core_new` that
/// has not already been freed.
#[no_mangle]
pub unsafe extern "C" fn sc_realtime_core_free(session: *mut Session) {
    if session.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(session))));
}

/// Execute one JSON command.
///
/// Returns an owned JSON response buffer, or null on failure. The response
/// always contains `frames`, `effects` and `errors` arrays.
///
/// # Safety
/// `session` must be valid for the duration of the call. `request` must point
/// to `request_len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn sc_realtime_core_handle(
    session: *mut Session,
    request: *const u8,
    request_len: usize,
) -> *mut ScBuffer {
    if session.is_null() {
        set_last_error("session pointer is null");
        return ptr::null_mut();
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        let raw = request_str(request, request_len)?;
        let session = &mut *session;
        Ok::<_, String>(session.handle_json(raw).into_bytes())
    }));

    match result {
        Ok(Ok(bytes)) => ScBuffer::from_vec(bytes),
        Ok(Err(message)) => {
            set_last_error(message);
            ptr::null_mut()
        }
        Err(_) => {
            set_last_error("panic while handling realtime core request");
            ptr::null_mut()
        }
    }
}

/// # Safety
/// `buffer` must be null or a pointer returned by this library.
#[no_mangle]
pub unsafe extern "C" fn sc_realtime_core_buffer_data(buffer: *const ScBuffer) -> *const u8 {
    if buffer.is_null() {
        return ptr::null();
    }
    (*buffer).data
}

/// # Safety
/// `buffer` must be null or a pointer returned by this library.
#[no_mangle]
pub unsafe extern "C" fn sc_realtime_core_buffer_len(buffer: *const ScBuffer) -> usize {
    if buffer.is_null() {
        return 0;
    }
    (*buffer).len
}

/// # Safety
/// `buffer` must be null or a pointer returned by this library and must not be
/// freed twice.
#[no_mangle]
pub unsafe extern "C" fn sc_realtime_core_buffer_free(buffer: *mut ScBuffer) {
    if buffer.is_null() {
        return;
    }
    let boxed = Box::from_raw(buffer);
    let _ = boxed.into_vec();
}

/// Returns and clears the last error as an owned JSON string buffer.
#[no_mangle]
pub extern "C" fn sc_realtime_core_last_error() -> *mut ScBuffer {
    let message = take_last_error().unwrap_or_default();
    ScBuffer::from_vec(serde_json::to_vec(&message).unwrap_or_else(|_| b"\"\"".to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    fn handle(session: *mut Session, request: &str) -> serde_json::Value {
        let c = CString::new(request).unwrap();
        unsafe {
            let buffer = sc_realtime_core_handle(session, c.as_ptr() as *const u8, request.len());
            assert!(!buffer.is_null());
            let data = sc_realtime_core_buffer_data(buffer);
            let len = sc_realtime_core_buffer_len(buffer);
            let bytes = slice::from_raw_parts(data, len).to_vec();
            sc_realtime_core_buffer_free(buffer);
            serde_json::from_slice(&bytes).unwrap()
        }
    }

    #[test]
    fn abi_roundtrip() {
        assert_eq!(sc_realtime_core_abi_version(), 1);
        let session = unsafe { sc_realtime_core_new(ptr::null(), 0) };
        assert!(!session.is_null());

        let out = handle(
            session,
            r#"{"op":"frame","connection_id":"c1","frame":["1","1","phoenix","heartbeat",{}]}"#,
        );
        assert_eq!(out["frames"][0]["frame"][3], serde_json::json!("phx_reply"));

        unsafe { sc_realtime_core_free(session) };
    }

    #[test]
    fn errors_do_not_unwind() {
        let session = unsafe { sc_realtime_core_new(ptr::null(), 0) };
        let out = handle(session, r#"{"op":"nope"}"#);
        assert_eq!(out["frames"].as_array().unwrap().len(), 0);
        assert_eq!(out["errors"].as_array().unwrap().len(), 1);
        unsafe { sc_realtime_core_free(session) };
    }
}
