# Release execution evidence

`supacloud.release-execution.v1` records what actually happened when an
uploaded application release was activated. It is deliberately separate from the
immutable `supacloud.release-evidence.v1` artifact document produced by the
compiler:

| Document | Answers | Source |
| --- | --- | --- |
| `release-evidence` | what was built and what it declares | verified delivery archive (static) |
| `release-execution` | what ran, what migrated, what health was observed | runtime observations (dynamic) |

The two are correlated by `release_id`, `manifest_sha256` and `target`, so a
release update produces new execution results and never inherits the old ones.

## Components

Each component is `succeeded`, `failed` or `unknown`. Required components are
`application`, `migrations` and `health`; `configuration`, `resources` and
`secrets` are optional but a `failed` optional component still blocks
verification.

`deploymentVerified` is `true` only when every required component is `succeeded`
and no component is `failed`. An unobserved component stays `unknown` — it is
never counted as success. A `succeeded`/`failed` observation must carry a
parseable `observedAt`, and an `unknown` observation must not carry a `version`
or `detail`.

## Endpoint

```http
POST /v1/projects/{project_ref}/applications/{id}/releases/{releaseId}/execution?target={target}
```

The release is read from immutable storage and the observations are validated
against it; the endpoint returns the document and does not claim deployment
success. It fails closed:

- an unknown `target` returns `404 RELEASE_EXECUTION_TARGET_NOT_FOUND`;
- a malformed observation returns `422 RELEASE_EXECUTION_INVALID`.

## Recovery paths

The document carries separate recovery paths per surface, reusing the same
strings as the artifact evidence:

- **application**: activate the previous immutable release;
- **database**: apply the reviewed migration repair path, with destructive
  changes still requiring explicit operator handling;
- **storage**: restore the referenced object version, since release evidence
  does not attest stored bytes.