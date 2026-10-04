# Release Evidence

Status: **IMPLEMENTED (compiler read-only slice)**. The compiler summarizes one
immutable delivery target into a single queryable document. Preview environment
provisioning, runtime health and activation identity are **not** part of the
compiler slice; see [Encore Alignment Roadmap](./encore-alignment-roadmap.md).

The platform-side companion contract is
`supacloud.deployment-evidence.v1`, exported by `@supacloud/delivery`. It
records deployment status, source/build identity, environment binding version,
database provider capabilities, component health, activation identity,
authenticated smoke results, and rollback readiness. It is intentionally a
read model: Management API and the single-node acceptance workflows remain
responsible for collecting the observations.

## Why

A release spans several artifacts: the build manifest, the embedded application
contract, the migration inventory and the rollback paths. Today they are read
from different surfaces, so "did this release succeed?" has no single answer.
Release evidence aggregates them from artifacts that were already hash-verified,
without claiming deployment success and without promising that one rollback
reverses everything.

## Command

```sh
supacloud-compiler release-evidence --delivery-manifest <file> --delivery-target <name> [--json]
```

The command is read-only. It verifies every inventoried file hash for the
selected target before reading the contract and migration inventory, and it
never falls back to the current source checkout.

## Schema

`supacloud.release-evidence.v1`:

| Field | Contents |
| --- | --- |
| `correlation` | `verified-build-snapshot` |
| `deploymentVerified` | Always `false` |
| `target` | The selected delivery target |
| `build` | producer, `manifestSha256`, object ID, entry kind/entrypoint, file count and byte total |
| `contract` | `present`/`absent`, contract schema, resource count, error/warning diagnostic counts |
| `migrations` | `present`/`absent`, count, latest version, `executionPerformed: false`, `compatibility: "not-proven"`, `dataRecovery: "separate-required"` |
| `rollback` | separate application, database and storage paths |
| `notes` | explicit non-guarantees |

`build.manifestSha256` is the SHA-256 of the canonical build manifest. It ties
the evidence to one immutable build without embedding absolute paths.

## Interpretation

Release evidence is **local artifact consistency**, not signed provenance,
deployment success, runtime health or account identity. The document deliberately
does not embed the source-control commit, the environment binding version or the
activation identity; those belong to the deployment record and must be correlated
separately.

Rollback is recorded as separate paths, not a single switch:

- **application**: activate the previous immutable release; the current object
  stays addressable.
- **database**: apply the reviewed migration repair path; destructive changes
  still require explicit operator handling.
- **storage**: restore the referenced object version; evidence does not attest
  stored bytes.

## Boundaries

- **Evidence vs deployment.** A verified build snapshot says nothing about
  whether the target environment is running, healthy or reachable.
- **No execution.** Reading evidence never executes application code or SQL.
- **Fail closed.** A missing target, a malformed inventory or a hash mismatch
  fails with `RELEASE_EVIDENCE_TARGET_NOT_FOUND` / `RELEASE_EVIDENCE_INVALID`.

## Next steps

1. Have the Management API persist and expose deployment evidence after each
   single-node activation or reconcile operation.
2. Connect Preview lifecycle and recovery drills to the database provider,
   backup, migration, health and rollback fields.
3. Surface build and deployment evidence together in the Web Console release
   view beside the application development context.
