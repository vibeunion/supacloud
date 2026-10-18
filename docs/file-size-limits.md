# File Size Limits

The optional document-conversion and Lite image-transformation input/output
limits are **500 MiB** by default. This includes the converted PDF output.
Image dimensions and pixel-count limits remain separate protections.

Document conversion environment variables:

```text
SUPACLOUD_DOCUMENT_CONVERSION_MAX_INPUT_BYTES
SUPACLOUD_DOCUMENT_CONVERSION_MAX_OUTPUT_BYTES
```

Both accept positive integer byte counts up to 524288000. Lite image
transformation uses `supabase/config.toml`:

```toml
[storage.image_transformation]
max_input_bytes = "500MiB"
max_output_bytes = "500MiB"
```

The programmatic Lite option is
`storageImageTransformLimits: { maxInputBytes, maxOutputBytes }`.
Both image limits accept 1 through 524288000 bytes. Omitted limits retain the
500 MiB default. Invalid settings fail startup instead of silently falling back.
Limits are captured at construction; restart the worker or Lite runtime after
changing configuration. URL parameters cannot override these operator limits.

These are processing limits, not a universal Storage quota. Storage buckets
still use their configured `file_size_limit`; when omitted, the Lite runtime
default is 500 MiB. A bucket or upload gateway may therefore reject a file
before a conversion or image transformation begins.

Configure the Lite project-wide upload default with `[storage].file_size_limit`
(for example, `"500MiB"`) or the programmatic `storageFileSizeLimit` byte count.
A bucket's explicit `file_size_limit` takes precedence over this default.
The default applies to ordinary and resumable uploads and destination copy checks.

On upgrade, existing explicit project and bucket limits are preserved; no database
migration rewrites bucket limits. Buckets without either setting use 500 MiB after
the runtime restarts. To retain the previous implicit limit, configure
`[storage].file_size_limit = "50MiB"` before upgrading.

The larger processing limit increases peak memory and temporary I/O risk.
Operators should size worker memory, concurrency and admission controls for
the selected workload. The default is expressed in MiB (`500 * 1024 * 1024`);
image rejection messages report the effective limit in bytes.

## Hosted Edge Runtime Requests

The hosted Edge Runtime defaults to a 500 MiB request-body limit. Set
`EDGE_MAX_BODY_SIZE_MB=500` on the runtime service to configure it, or use the
installer's `edge_max_body_size_mb` option. Despite the environment variable's
name, units are MiB (1024 * 1024 bytes). Restart the runtime after a change.

An explicit positive setting is preserved. Omitted or invalid settings retain
the existing fallback behavior, now falling back to 500 MiB instead of 30 MiB.
To retain the previous default on upgrade, set `EDGE_MAX_BODY_SIZE_MB=30`.
The HTTP listener uses the greater of 128 MiB and the effective runtime limit;
the worker still enforces the runtime limit and any smaller function-level
`max_request_body_bytes`. This change does not alter Lite strict-mode limits,
function-level overrides, response limits, or external reverse-proxy limits.

This is a whole-request limit, not a file-payload allowance: multipart encoding
adds bytes, so a 500 MiB file needs a larger configured request-body limit.
Large bodies are buffered by the worker; review memory and concurrency before
restarting with the larger default. No database or existing bucket settings are
rewritten.
