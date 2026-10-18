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

Management API project-scoped image transforms use the same 500 MiB default for
source and `max_bytes` output filtering. Set
`SUPACLOUD_IMAGE_TRANSFORM_MAX_BYTES` to a positive byte count up to
524288000 to lower that limit for the service, then restart it. This is an
operator limit; URL parameters cannot raise it.
