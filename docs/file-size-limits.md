# File Size Limits

The optional document-conversion input limit and Lite image-transformation
input/output limit are **500 MiB** by default. The document-conversion PDF
output limit remains **64 MiB**. Image dimensions and pixel-count limits remain
separate protections.

These are processing limits, not a universal Storage quota. Storage buckets
still use their configured `file_size_limit`; when omitted, the Lite runtime
default is 50 MiB. A bucket or upload gateway may therefore reject a file
before a conversion or image transformation begins.

The larger processing limit increases peak memory and temporary I/O risk.
Operators should size worker memory, concurrency and admission controls for
the selected workload. The limit is expressed in MiB (`500 * 1024 * 1024`),
while user-facing errors use the conventional `500MB` wording.
