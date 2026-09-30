# Preview isolation trust boundary

This note supersedes examples that treat caller-supplied `ok: true`, `healthy`
or `accepted` fields as verified isolation. The Supabase-compatible branch model
and pre-existing branch ownership are unchanged by this correction.

`POST /previews/acceptance` is a compatibility planning endpoint. Its caller
assertions are untrusted: checks stay pending, `accepted` stays false and
`evidence_source` is `caller-unverified`. It does not collect runtime evidence.
Use `POST /previews/isolation-collection` with an explicitly configured trusted
collector for observed isolation. Without that port the route returns 501.

Every collector observation must carry a boolean `ok`, a non-empty collector
identifier, the exact check name, project/application/environment/branch/preview/
release identity, explicit configuration identity (null when none), and a valid
`observed_at` / `expires_at` interval containing the collection time. Missing,
expired, future, inherited or mismatched metadata is discarded. The selected
identity and each collector input are detached so asynchronous mutation cannot
redirect validation. Four distinct canonical checks are required before the
collector is called; an empty set cannot be accepted. An observed failure remains
failed, not pending. Collector errors do not expose backend response bodies.

Collection acceptance describes isolation checks only; it does not establish
provisioning, health, ownership, deployment or promotion authorization. Metadata
matching is not cryptographic attestation. The collector registration is a trusted
server boundary and must query the actual systems, not echo an HTTP payload.

Full-clone planning permission comes from the authenticated platform principal
(admin or master). The legacy `authorized_full_clone` body field cannot grant it.
Execution still requires independent masked-data policy and resource ownership.

Known integration blockers remain outside this correction: branch state updates
need atomic compare-and-swap / generation protection; stores must reject missing
or foreign branches instead of manufacturing active records; direct pure evaluator
and provisioning consumers need equivalent empty-set and identity guards. These
requirements must be verified before the complete Preview implementation merges.
