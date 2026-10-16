# Optional Collabora Document Conversion

## Scope And Acceptance

Applications need reusable, project-scoped DOCX/XLSX to PDF conversion without
installing an office suite in every SupaCloud deployment. This first increment
uses Collabora Online through an opt-in Worker subpath, not a published conversion application or an
anonymous HTTP endpoint. It does not install services, start workers, provision
queues, change the browser SDK, or migrate application exports.

```gherkin
Scenario: An installation does not opt in
  Given conversion is absent or explicitly disabled
  When a caller requests conversion
  Then it receives DOCUMENT_CONVERSION_DISABLED without network access
  And original document generation and download are unchanged

Scenario: An authorized project converts an immutable source
  Given a trusted worker authorizes an immutable DOCX or XLSX artifact
  When its project, source checksum and render profile match
  Then only those file bytes are uploaded to the configured engine
  And a bounded PDF result includes source and output checksums

Scenario: A request violates the conversion boundary
  Given a different project, wrong checksum, unsupported format or full capacity
  When conversion is requested
  Then it is rejected before calling the engine

Scenario: The engine fails or stalls
  Given an HTTP error, redirect, oversized output, invalid PDF or expired deadline
  When the worker receives that response
  Then no conversion result is returned
  And a bounded error code is returned without engine bodies or credentials

Scenario: An application adopts conversion
  Given a separately deployed engine and approved fonts
  When real source documents pass layout and authenticated workflow acceptance
  Then that project may explicitly switch its conversion implementation
  And there is no silent engine fallback

Scenario: An installation selects an engine
  Given conversion is enabled
  When the environment does not explicitly select collabora-online
  Then startup fails before making a request
  And no other converter or local office process is selected automatically
```

## Configuration

Import `@supacloud/worker/document-conversion` only in trusted server/Worker
code. The subpath does not load pgflow or start anything at import time.
`@supacloud/worker` remains private; this is not an npm availability claim.

`createDocumentConverterFromEnvironment(environment)` reads an explicit
environment map (it does not implicitly read process globals):

```sh
SUPACLOUD_DOCUMENT_CONVERSION_ENABLED=false
# Required only when enabled:
SUPACLOUD_DOCUMENT_CONVERSION_ENGINE=collabora-online
SUPACLOUD_PROJECT_REF=project-a
SUPACLOUD_DOCUMENT_CONVERSION_URL=http://collabora.internal:9980
SUPACLOUD_DOCUMENT_CONVERSION_RENDER_PROFILE=collabora-fonts-v1
# Optional: bearer credential for your own internal gateway, not native
# Collabora authentication:
# SUPACLOUD_DOCUMENT_CONVERSION_TOKEN=...
```

Only literal `true` enables conversion; absent/`false` disables it, other
values are configuration errors. Enabled environment factories require
`SUPACLOUD_DOCUMENT_CONVERSION_ENGINE=collabora-online`; there is no
auto-detection, Gotenberg backend, local `soffice` process or implicit fallback.
`createCollaboraDocumentConverter(options)` is the equivalent explicit factory.
Enabled instances bind one project and one
render profile. The profile is operator-controlled and must change whenever
the pinned Collabora build, fonts, locale or conversion options
change. It is a declared identity, not automatic verification of the server.
Never derive the endpoint, credentials or profile from a browser payload.
The endpoint origin must have no credentials, query, fragment or path prefix.
The engine identifier records operator intent, not remote attestation:
an endpoint named `/cool/convert-to/pdf` is not proof it runs Collabora.
Confirm the deployed product/build independently before enabling it.

The selected product is Collabora Online, not the desktop Collabora Office
application. Collabora has LibreOffice-derived rendering technology; this
implementation selects Collabora's maintained service and does not claim a
completely unrelated rendering codebase.

Factory options can lower the 500 MiB input and 64 MiB output ceilings and set
the request timeout (default 120 seconds, maximum 120 seconds). Default
concurrency is one per instance; the hard cap is four. Busy requests fail
immediately rather than queueing large buffers. This is not a distributed
quota: use existing execution-group admission and host resource budgets for
replicas. Revoke/disable a project by stopping admission and draining/stopping
its worker; an instance captures its configuration at creation.

The adapter accepts only `.docx`/`.xlsx` with the matching MIME type, a ZIP
header and a matching SHA-256. ZIP header validation is not OOXML validation
or protection against decompression bombs. The engine must be sandboxed.
Source bytes are copied before hashing/upload so caller mutations cannot
change the converted content. The original filename is not sent to the engine.

## Execution And Artifacts

See `packages/worker/examples/document-conversion-worker.ts` for the existing
queue-handler boundary. Keep the application's durable operation ID, request
status and idempotency receipt; a queue message ID is not a result/job ID.
The example requires authorized source reading and immutable private result
publication ports. It is not a preconfigured Storage integration.

The trusted producer must authorize the requested source, commit intent and
enqueue atomically using the existing command/outbox or PGMQ APIs. Store only
small immutable IDs, checksum, format and render profile in the job.
The worker reauthorizes before reading and before publishing. The publication
port must fence stale attempts, verify the operation identity, deduplicate
replays and atomically associate the result with the operation. Collabora
output bytes may differ across retries; do not assume identical PDF hashes.

Store results in a private bucket, register them with the existing artifact
registry, and link the source using `artifacts.link`. Capture the checksums,
render profile, immutable object version and retention policy. Neither this
adapter nor an artifact retention timestamp automatically deletes Storage
objects; the operator must provision TTL/orphan cleanup before exposure.
Downloads must reauthorize the business operation and use short-lived links
or an authenticated stream. FA still owns approval, watermarking and access
consumption; this PR does not change FA or ONLYOFFICE.

Use the existing Worker retry budget and visibility timeout, not a new
in-memory job queue. Conversion performs one HTTP attempt. Error codes have a
`retryable` hint, but only the scheduler/host controls retries and terminal
status. A client timeout or cancellation does not prove engine work stopped;
account for this when sizing capacity and visibility timeouts. Source fetch
and result publication also need independent bounded deadlines within the
queue lease; the converter's timeout covers only its own HTTP request/body.

## Engine Deployment Gate

Deploy Collabora Online separately on an internal isolated network or behind a
service-authenticated gateway. Publish only `POST /cool/convert-to/pdf`
to the worker. Do not expose the raw API publicly, and do not accept
`downloadFrom`, webhooks, caller-supplied form fields or destination URLs.
The adapter uses a single multipart `data` field with a fixed target PDF route.
It does not send Gotenberg fields or request arbitrary conversion/filter options.
In particular it does not set `FullSheetPreview`: spreadsheet pagination remains
subject to the document and the configured Collabora build. This is not a
guarantee that it matches the existing FA upload converter's print behavior.
Do not migrate FA merely because the route names match.
It refuses redirects and never fetches a user-supplied URL.

Uploads can contain external document references. Blocking arbitrary URLs
at the adapter alone is not sufficient SSRF protection: deny engine egress,
including cloud metadata, host/private services and external networks.
Do not mount secrets, host directories or application credentials into the
engine. Use an unprivileged container with CPU, memory, PID and temporary-disk
limits, engine-side request deadlines and bounded queue capacity. Review
macros, embedded objects, external links and current security advisories.

Pin a reviewed image digest and record Collabora build, locale, timezone
and a licensed font manifest. No image is automatically pulled or installed
by this change. No desktop suite, engine source, or CODE image is bundled.
Select an appropriate supported deployment and review its applicable license,
support/usage terms and fonts separately. This adapter neither purchases a
subscription nor includes commercial distribution rights. Do not silently
substitute a rolling development image for a production deployment.
An upstream allowlist (`net.post_allow` where supported) and the gateway's
actual peer rules must restrict conversion clients. A caller-supplied forwarded
IP header is not authorization. Provision and verify those settings against
the chosen build; this PR does not change them.

Before enabling any application:

1. Run real Chinese DOCX/XLSX fixtures, not just synthetic HTTP responses.
2. Compare page count, wrapping, headers/footers, long tables, embedded images,
   signatures and spreadsheet print areas with approved PDFs.
3. Exercise malformed/encrypted documents, compressed-size bombs, egress
   denial, cancellation, resource exhaustion and worker restart/replay.
4. Verify private-result authorization, cross-project denial, TTL cleanup and
   no access consumption when conversion fails.
5. Keep rollback an explicit application switch; do not silently choose a
   different renderer for the same artifact identity.

Local verification is limited to the focused adapter/handler test file,
strict type checking of those files and `git diff --check`.
From `packages/worker`, run:

```sh
bun --no-env-file test tests/document-conversion.test.ts
bunx tsc --ignoreConfig --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --strict --noUncheckedIndexedAccess \
  --exactOptionalPropertyTypes --skipLibCheck --noEmit --types bun \
  src/document-conversion.ts tests/document-conversion.test.ts \
  examples/document-conversion-worker.ts
```

The fixtures include local HTTP multipart/redirect servers and mocked conversion
responses. They establish transport and authorization boundaries, not layout
compatibility, a running engine, deployed infrastructure or live acceptance.

Official references:

- https://www.collaboraonline.com/document-conversion/
- https://sdk.collaboraonline.com/docs/conversion_api.html
