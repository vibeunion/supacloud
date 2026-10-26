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

Application and frontend release uploads also use a 500 MiB default archive and
artifact ceiling. Frontend archives may contain at most 10,000 files; these
file-count and format protections remain independent of the byte limit.

## Hosted Edge Runtime Requests

The hosted Edge Runtime source defaults to a **30 MiB** request-body limit.
Set `EDGE_MAX_BODY_SIZE_MB` on the runtime service, or the installer's
`edge_max_body_size_mb` option, to override it. Units are MiB (`1024 * 1024`
bytes). Omitted or invalid runtime settings fall back to 30 MiB; the HTTP
listener has a 128 MiB minimum ceiling. The worker still enforces any smaller
function-level `max_request_body_bytes`. External proxies can impose lower limits.
Restart the runtime after changing configuration.

This is a whole-request limit, not a file-payload allowance: multipart encoding
adds bytes. Uploads are checked incrementally, before a contiguous Worker
transfer is allocated. Accepted uploads are still buffered before the handler
runs; this preserves early 413 behavior even when the handler ignores its body.
A process-wide buffer budget bounds admission across both worker pools and can
return 503 before the per-request limit is reached. Increase that budget together
with unusually large upload limits, accounting for collection and transfer copies.
See [Edge Function memory controls](edge-function-memory.md).

Management API project-scoped image transforms use the same 500 MiB default for
source and `max_bytes` output filtering. Set
`SUPACLOUD_IMAGE_TRANSFORM_MAX_BYTES` to a positive byte count up to
524288000 to lower that limit for the service, then restart it. This is an
operator limit; URL parameters cannot raise it.

Management API standard Storage uploads also advertise and enforce a 500 MiB
default. `STORAGE_UPLOAD_MAX_BYTES` can lower it; the effective value is never
higher than `MANAGEMENT_API_MAX_REQUEST_BODY_SIZE`, because the HTTP listener
must be able to receive the request. TUS uploads use the separate
`TUS_MAX_SIZE` setting, whose default is also 500 MiB.
