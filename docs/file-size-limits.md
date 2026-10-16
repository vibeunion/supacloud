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
default is 50 MiB. A bucket or upload gateway may therefore reject a file
before a conversion or image transformation begins.

The larger processing limit increases peak memory and temporary I/O risk.
Operators should size worker memory, concurrency and admission controls for
the selected workload. The default is expressed in MiB (`500 * 1024 * 1024`);
image rejection messages report the effective limit in bytes.
