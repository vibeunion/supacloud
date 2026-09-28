# Starter Compatibility Command

This is the concrete preactivation verifier for the shipped review starter's
`api` and `jobs` targets, including the reference revision-2 upgrade. It consumes
the existing `supacloud.application-compatibility-request.v1` JSON on stdin and
emits a fresh nonce/input-digest-bound result only after actual probes succeed.
It is not a general compatibility verifier for arbitrary application code.

## Build And Install

From the repository root (no application/compiler rebuild):

```sh
bun build packages/management-api/src/scripts/verify-starter-compatibility.ts \
  --compile --target=bun-linux-x64 --outfile=/tmp/starter-verify
```

Use `bun-linux-arm64` for an ARM64 acceptance host. Installation is an explicit
operator action; the verifier never installs itself, provisions SQL, or changes
the tenant. The default Management API transport already selects:

```text
/etc/supacloud/application-verifiers/<project>/<application>/<environment>/verify
```

Install the compiled binary there as root, mode `0755`; all ancestors must be
root-owned, non-symlinks and not group/world writable. Install its sibling
`starter-policy.json` as root, mode `0600`. Do not install the unbundled source
as `verify`. No callback, custom shell probe, compiler, or repository is needed
on the acceptance host.

The policy fields are:

```json
{
  "schema": "supacloud.starter-compatibility-policy.v1",
  "project_ref": "<owned-project>",
  "application_id": "<application>",
  "environment_id": "<environment>",
  "environment_sha256": "<stableSha256 of the exact api/jobs environment object>",
  "releases": [
    { "manifest_sha256": "<reviewed starter archive manifest digest>", "revision": 1 }
  ],
  "database": "supa_<owned-project>",
  "http_role": "<restricted HTTP LOGIN>",
  "worker_role": "<restricted Worker LOGIN>",
  "inspection": { "socket": "/var/run/postgresql", "username": "<inspection account>" },
  "identity_token": "<fresh authenticated starter member token>"
}
```

`inspection` alternatively accepts `{ "url": "<private project database URL>" }`.
It needs read access to the starter, Storage, Workflow and PGMQ tables; every
inspection transaction is explicitly read-only, with statement/lock timeouts.
The two application connections use their actual configured credentials and
must be distinct restricted LOGINs with exactly their respective starter role.
The database binding must match both the policy project and configured tenant.

Calculate the environment digest with the same `stableSha256` implementation
used by Management API, not a hash of arbitrary JSON serialization. Approving
a new configuration requires updating that digest. Approval of a manifest means
the operator has reviewed it as the shipped starter at the indicated revision;
unknown manifests fail closed. Add revision `2` only for the reference upgrade
that requires `delivery_revision=2` and writes `writer_revision='v2'`.

The identity token is an expiring, private probe credential, not a service key.
It must pass configured HTTPS JWKS signature/issuer/audience/client validation,
GoTrue's `/auth/v1/user`, and the live starter membership/storage-subject mapping.
Refresh it through the existing identity flow; the verifier neither logs in nor
mints tokens. A private CA may be supplied as PEM in `ca`, and must also be
installed in the application host's trust store. Never disable TLS verification.

The default runtime probe executes `/opt/supacloud/bun/<configured-version>/bun`.
`bun_executable` is an explicit diagnostic override for local native testing;
it is accepted only with `--policy`. Installed no-argument mode rejects this
field and always checks the actual systemd path.

For a local operator diagnostic, the source or binary accepts `--policy PATH`.
That file must be owned by the executing account, private and not a symlink.
Do not place credentials in command arguments or save request JSON in logs.

## Evidence And Limits

Checks include actual starter queries under both runtime roles, forbidden
privileges and role memberships, schema revision and writer query planning,
RLS/bucket provisioning, all 14 platform wrappers' ownership/EXECUTE boundary,
queue inventory and foreign-message rejection. Each configured service key
reads the project binding and invokes the existing read-only Workflow get RPC.
No queue claims, business writes, migrations, wrapper repairs or tenant
provisioning are performed.

The Bun subprocess exercises a real loopback HTTP round trip, async context,
SQL API availability and exact version. This is engine compatibility, not
startup of an uploaded bundle. Actual target identity/PID readiness remains
the activation service's post-start gate. No uploaded code executes as root.

This is a bounded preactivation check, not a proof of arbitrary SQL semantics,
perpetual queue exclusivity, Storage write authorization, external IdP lifecycle,
business workflow completion, rollback or recovery. Those remain real-platform
acceptance requirements. Local TLS test adapters are not GoTrue or PostgREST;
the native test uses Lite's SQL PGMQ implementation, not the native extension.

## Local Test

```sh
SUPACLOUD_STARTER_POSTGRES_BIN=/opt/homebrew/opt/postgresql@18/bin \
  bun test packages/management-api/tests/unit/application-starter-compatibility-native.test.ts
bun x tsc --project packages/management-api/tsconfig.application-starter-compatibility-tests.json
```

This creates only a disposable loopback PostgreSQL cluster and TLS test server,
builds the verifier in a temporary directory, executes it through the existing
transport, exercises failure cases and verifies repeated probes do not change
business/queue row counts. Missing native PostgreSQL selection skips the native
test explicitly. No full-platform fixture is modified or run.
