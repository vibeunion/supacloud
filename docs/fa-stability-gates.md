# FA Stability Gates

This is the platform-owned stability gate for the `xigu-fa` consumer. It
deliberately excludes report export and shared export retry.

## Delivery Tuple

Every release records one immutable tuple containing the FA commit, repository
CLI version, SupaCloud platform commit and Edge Runtime artifact hash. The
compatibility window must state whether old clients and partial deployment are
supported. A tuple is not a deployment receipt; the active artifact and
runtime read-back remain separate evidence.

## Contract Matrix

`docs/fa-contract-matrix.json` is a deliberately synthetic example, not a tested
release. It covers all eight old/new frontend, Function and database
combinations. Each combination must prove missing display fields, missing
authority fields, added fields, legacy envelopes, lost write responses and
downgrade behavior. Missing authority must fail closed.

## Gates

```sh
bun run check:fa-stability -- --level daily --tuple docs/examples/fa-delivery-tuple.fixture.json --matrix docs/fa-contract-matrix.json
bun run check:fa-stability -- --level release --tuple /archive/tuple.json --matrix /archive/matrix.json --evidence /archive/evidence.json --objectives /archive/objectives.json --project PROJECT_REF --environment test
bun run check:fa-stability -- --level platform-change --tuple /archive/tuple.json --matrix /archive/matrix.json --evidence /archive/evidence.json --objectives /archive/objectives.json --project PROJECT_REF --environment production
```

Daily checks only report `definitions-valid`, never deployment success. Release
and platform-change checks additionally require real operation evidence, a
confirmed rollback drill and approved SLO observations. Evidence is bound to the
tuple, matrix, project, environment and objectives. Archive files are bounded,
hash-checked and cannot escape the archive root or follow symbolic links.
Missing, stale, duplicate or explicitly fake-backed results fail closed.

JSON and file hashes cannot attest that a test really ran or that a named owner
approved it. Release operators must review the archived raw evidence and approval
reference. A fixture with invented identities/hashes is not an accepted release.
No script creates approval or production evidence automatically.

## Error Contract

Command failures expose `retryability`, `idempotency`, `deadlineAt` and
`outcome`. A lost write response is `outcome: "unknown"` and only permits
read-only confirmation. A new write cannot be generated from a timeout.

## SLO Evidence

Terminal logical-operation observations measure login, permissions, upload,
async tasks, report reads (not export), and deployment separately. Success rate
includes failures, timeouts and unknown outcomes in its denominator. Nearest-rank
p95 includes all terminal outcomes; retries and rollbacks are recorded separately.
Missing traffic fails the minimum-sample requirement and cannot imply 100% uptime.
Every observation must match the delivery tuple and the approved time window.

The existing Prometheus/VictoriaMetrics rules measure Management API errors and
latency, background failures and queue delay, backup freshness, restore drills
and log ingestion. Business owners must approve the FA objective values and
observation window. Platform code does not sign those values on their behalf.

This change implements evidence validation and protocol primitives. It does not
install business instrumentation, exercise real business flows or rollout drills,
approve objectives, deploy packages or establish online SLO compliance.
