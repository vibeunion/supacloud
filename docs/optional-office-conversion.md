# Optional Legacy Office Conversion

## Scope

SupaCloud can optionally convert legacy OLE Office files to modern OOXML:

| Input | Output |
| --- | --- |
| `.doc` | `.docx` |
| `.xls` | `.xlsx` |
| `.ppt` | `.pptx` |

The adapter lives at `@supacloud/worker/office-conversion`. It is default-off,
bound to one project and render profile, and never starts a process at import
time. The worker invokes a separately built Rust helper that uses
`office_oxide`. The helper is a short-lived child process, not a daemon, so the
existing Worker service remains the lifecycle and systemd boundary. No Office
converter systemd unit is installed.

This feature does not replace the existing DOCX/XLSX to PDF path described in
[`optional-document-conversion.md`](./optional-document-conversion.md), and it
does not change PDF or video-thumbnail handling.

## Build And Install

Rust and Cargo are required only when the optional binary is installed:

```sh
scripts/build_supacloud_office.sh
sudo scripts/install_supacloud_office.sh
```

The explicit installer places the binary at
`/usr/local/bin/supacloud-office-converter` and does not start a service. A
non-root or staged installation can select another absolute path:

```sh
OUT_DIR="$PWD/dist/office" \
SUPACLOUD_OFFICE_CONVERSION_BIN="$PWD/dist/bin/supacloud-office-converter" \
scripts/install_supacloud_office.sh
```

Pin Rust, the `office_oxide` version in
`crates/office-converter/Cargo.toml`, and the resulting binary in the
deployment artifact. Do not build or install it in the default SupaCloud
profile.

## Worker Configuration

Only the literal value `true` enables the feature. Missing or `false` keeps
the adapter disabled without spawning a process. Enabled workers require every
identity below:

```sh
SUPACLOUD_OFFICE_CONVERSION_ENABLED=false
SUPACLOUD_OFFICE_CONVERSION_ENGINE=office-oxide
SUPACLOUD_PROJECT_REF=project-a
SUPACLOUD_OFFICE_CONVERSION_RENDER_PROFILE=office-oxide-v1
SUPACLOUD_OFFICE_CONVERSION_BIN=/usr/local/bin/supacloud-office-converter
SUPACLOUD_OFFICE_CONVERSION_MAX_INPUT_BYTES=524288000
SUPACLOUD_OFFICE_CONVERSION_MAX_OUTPUT_BYTES=524288000
SUPACLOUD_OFFICE_CONVERSION_TIMEOUT_MS=120000
SUPACLOUD_OFFICE_CONVERSION_MAX_CONCURRENT=1
```

The default input/output ceiling is 500 MiB, timeout is 120 seconds, and
per-instance concurrency is one. Hard caps are 500 MiB and four concurrent
conversions. There is no auto-detection, local `soffice` fallback, Node native
binding fallback, or silent engine substitution.

Trusted Worker code constructs the adapter explicitly:

```ts
import { createOfficeConverterFromEnvironment } from "@supacloud/worker/office-conversion";

const converter = createOfficeConverterFromEnvironment(process.env);
```

Use [`examples/office-conversion-worker.ts`](../packages/worker/examples/office-conversion-worker.ts)
with `createPgflowQueueWorker`. The application owns the producer, operation
receipt, source authorization, bounded source read and private artifact
publication. The example reauthorizes before reading and again before
publishing; it does not expose a public conversion endpoint.

## Security And Acceptance

Before enabling a project:

1. Restrict the worker's executable path and run it as an unprivileged user.
2. Keep source and output files in the adapter's private temporary directory;
   the adapter uses `0600` input files and removes the directory after each
   attempt.
3. Treat OLE and OOXML magic checks as envelope checks, not full document
   validation. The engine still needs process, CPU, memory, PID and temporary
   disk limits.
4. Test real Chinese DOC/XLS/PPT samples, including tables, fonts, images,
   charts, embedded objects, malformed/encrypted files and macro-bearing files.
5. Verify replay fencing, cancellation, worker restart, cross-project denial,
   private result authorization and orphan cleanup on the actual deployment.

Complex layout, macros, OLE objects, charts and embedded media are not promised
to round-trip perfectly. Keep the conversion behind an explicit application
switch and retain the original artifact for rollback.

## License And Runtime Notes

`office_oxide` is an optional Rust dependency of the helper crate, not a
default Worker or Node dependency. The current integration deliberately avoids
Node native bindings so Bun's worker runtime does not need `node-gyp`, a native
module loader or a second process ABI contract. Review the selected crate
version and any transitive license/security notices before publishing a
deployment artifact.
