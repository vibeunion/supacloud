# SupaCloud Docker Compose Self-Host

This stack is isolated from `docker/dev` and is intended for one-command self-host bootstrapping.

## Included services

- PostgreSQL 18
- Caddy (API gateway, managed via Admin API)
- GoTrue
- PostgREST
- SupaCloud Management API
- SupaCloud Bun Edge Runtime
- VictoriaLogs (persistent project logs)
- FerretDB MongoDB wire protocol gateway, optional through the `ferretdb` Compose profile

On an empty first start, Caddy validates and serves a bootstrap Caddyfile on ports `80` and `443`; both listeners return `503` until Management publishes the real routing JSON. Bootstrap HTTPS uses one fixed internal certificate for `supacloud-bootstrap.invalid` as the default and fallback SNI, so it can fail closed without issuing certificates on demand. Clients must not trust or hostname-validate that bootstrap-only certificate. Once Management has durably persisted and read back the real JSON, it creates `/etc/supacloud/caddy/INITIALIZED`. Every later Caddy start validates and serves `/etc/supacloud/caddy/config.json` directly, including a Caddy-only container recreation. If the marker remains but the JSON is missing, or if the JSON fails `caddy validate`, Caddy fails closed and leaves the mounted evidence untouched.

The Compose volumes enforce the runtime ownership boundaries: Management writes `frontend-data` and `caddy-managed-config`, while Caddy mounts both read-only. `caddy-managed-state` stays writable from both containers because Management stores manual certificates there and Caddy's configured `file_system` storage writes on-demand TLS state there. Caddy's own `/data` and `/config` volumes remain separate. Caddy does not depend on Management; Management waits for Caddy health before completing its startup recovery and reconciliation. Tenant routes (`/rest/v1`, `/auth/v1`, `/functions/v1`, `/platform/v1`) remain owned by the durable JSON, never by the bootstrap Caddyfile.

## Packaged PostgreSQL extensions

The PostgreSQL image stays on `postgres:18-bookworm` and installs PGDG, Pigsty/PGEXT, and DocumentDB packages. It bootstraps these common Supabase/SupaCloud extensions when available:

- `uuid-ossp`
- `pgcrypto`
- `pg_stat_statements`
- `pg_cron`
- `pgaudit`
- `pgvector`
- `postgis`
- `hypopg`
- `pg_stat_kcache`
- `http`
- `pg_graphql`
- `pg_jsonschema`
- `wrappers`
- `index_advisor`
- `pg_net`
- `wal2json`

It also packages these PostgreSQL libraries and optional extensions:

- `supautils`
- `pg_plan_filter`, loaded as `plan_filter`
- `documentdb`, created only when the FerretDB profile is enabled
- `pgsodium`, created only when `ENABLE_PGSODIUM=true`
- `supabase_vault`, created only when `ENABLE_SUPABASE_VAULT=true`

It also sets:

- `shared_preload_libraries=pg_stat_statements, pg_cron, pgaudit, pg_net, pg_stat_kcache, plan_filter, pg_documentdb, pg_documentdb_core`
- `cron.database_name=${POSTGRES_DB}`
- `wal_level=logical`

When `ENABLE_PGSODIUM=true`, it also adds `pgsodium` to `shared_preload_libraries`, configures `pgsodium.getkey_script`, and creates the `pgsodium` extension during first database initialization.

When `ENABLE_SUPABASE_VAULT=true`, it also adds `supabase_vault` to `shared_preload_libraries`, configures `vault.getkey_script`, and creates the `supabase_vault` extension during first database initialization.

## Quick start

Generate a production-grade `.env`:

```bash
cd docker/self-host
python3 init-env.py --public-url https://api.example.com --studio-url https://studio.example.com --output .env
```

Then boot the stack:

```bash
docker compose up -d --build
```

When upgrading data created by a release that derived `enc:v1` values from
`MASTER_TOKEN`, generate the new `.env` once with the old token supplied as
`--legacy-secrets-encryption-key`. The key is written only to the root-only
`.legacy-secrets-migration.env` one-shot file, never to the Compose environment.
`management-api` keeps that file intact when initialization fails and truncates
it only after the durable encryption checkpoint commits. Startup rejects
non-regular, symbolic-link, or group/world-accessible migration inputs. New
installations get an empty `0600` migration file.

Endpoints:

- API gateway: `${PUBLIC_URL}` (default `http://localhost:8000`)
- Management API / Studio shell: `${STUDIO_URL}` (default `http://localhost:9090`)

## TrueNAS SCALE

For TrueNAS SCALE `Custom App` deployment of the published PostgreSQL image, see [`TRUENAS.md`](./TRUENAS.md).

## Optional FerretDB profile

FerretDB is disabled by default. To expose the MongoDB wire protocol on top of the same PostgreSQL container and `postgres-data` volume, enable it before the first database initialization:

```bash
ENABLE_FERRETDB=true COMPOSE_PROFILES=ferretdb docker compose up -d --build
```

The profile creates a separate FerretDB database user and installs `documentdb` in `${FERRETDB_DATABASE}`. By default `${FERRETDB_DATABASE}` is the same as `${POSTGRES_DB}` because `documentdb` depends on `pg_cron`, and `pg_cron` can only be created in the database configured by `cron.database_name`. The MongoDB wire protocol endpoint is exposed on `${FERRETDB_PORT}` (default `27017`).

If `postgres-data` already exists, Docker entrypoint init scripts will not run again. Enable FerretDB on a fresh volume or create the FerretDB role/database and `documentdb` extension manually.

## PgSodium and Vault runtime

The recommended `init-env.py` quickstart enables `pgsodium` and Supabase Vault and generates independent, stable 64-character hex keys. Rerunning the generator preserves those keys. This makes the built-in Stripe and MongoDB Wrappers usable on a fresh standard installation.

The manual `.env.example` template remains fail-closed with both extensions disabled because PostgreSQL must never start encrypted storage with a placeholder or ephemeral key. If you use that template instead of the generator, enable the extensions on a fresh database volume only after setting stable keys:

```bash
ENABLE_PGSODIUM=true
PGSODIUM_KEY=<64-character-hex-key>
PGSODIUM_ENABLE_EVENT_TRIGGER=off
```

Generate a key with:

```bash
openssl rand -hex 32
```

Prefer mounting the key as a secret file and setting `PGSODIUM_KEY_FILE` when your runtime supports it. `PGSODIUM` is provided as a simple fallback for Compose and Custom App deployments.

To create Supabase Vault on top of the same runtime, also set:

```bash
ENABLE_SUPABASE_VAULT=true
```

Vault can use its own root key:

```bash
VAULT_KEY=<64-character-hex-key>
```

or its own secret file:

```bash
VAULT_KEY_FILE=/run/secrets/vault_key
```

If `VAULT_KEY` and `VAULT_KEY_FILE` are both unset, Vault falls back to `PGSODIUM_KEY_FILE`, then `PGSODIUM_KEY`.

`ENABLE_SUPABASE_VAULT=true` requires `ENABLE_PGSODIUM=true`. The active Vault key must stay stable across restarts and upgrades; rotating it without a planned migration can make encrypted data unreadable.


## Rolling back pgsodium

If you enabled pgsodium on a fresh volume and need to disable it:

1. Stop the stack: `docker compose down`.
2. Remove or rename the `postgres-data` volume to start fresh: `docker volume rm supacloud_postgres-data`.
3. Set `ENABLE_PGSODIUM=false` and `ENABLE_SUPABASE_VAULT=false` in `.env`.
4. Start the stack again: `docker compose up -d --build`.

**Important**: Once pgsodium has been initialized, encrypted data (including Vault secrets) depends on the original key. Starting over with a new volume means that data is lost. If you need to keep existing data, do **not** remove the volume. Instead, keep the same `PGSODIUM_KEY` or `PGSODIUM_KEY_FILE` value and simply stop using the `pgsodium` and `vault` schemas. The extension stays loaded in `shared_preload_libraries` until you rebuild PostgreSQL with `ENABLE_PGSODIUM=false` on a fresh volume.

## Frontend release activation: unresolved `outcome_unknown` recovery

Management refuses to open its listener while any frontend release activation mutation is still unresolved (`pending`, `running`, `failed_retryable`, or `outcome_unknown`). Startup first drains every automatically recoverable row; only rows whose outcome cannot be proven remain. Because the Compose service uses `restart: unless-stopped`, an unresolved `outcome_unknown` row keeps the container in a restart loop. This is an intentional fail-closed gate: the platform cannot prove whether the gateway route was switched, so it refuses to serve rather than risk split-brain route authority.

Symptom: the Management container never becomes healthy and logs `Frontend release activation remains unresolved after startup recovery`.

Diagnosis:

1. Find the blocking mutation in the platform database:
   `SELECT project_ref, mutation_id, operation, resource_key, principal_type, principal_id, fencing_epoch, checkpoint, receipt, completed_at FROM project_mutations WHERE status = 'outcome_unknown' ORDER BY updated_at;`
2. Establish ground truth on the gateway: compare the live Caddy configuration (`GET http://localhost:2019/config/`) and the durable JSON in the `caddy-managed-config` volume against the release recorded in the mutation's `resource_key`/`checkpoint`. Decide whether the activation actually took effect.

Resolution:

- There is deliberately no public reconciliation endpoint; `POST /v1/projects/:ref/mutations/:id/reconcile` returns 403. Reconciliation is an internal, audited operation (`reconcileProjectMutation` in `packages/management-api/src/services/project-mutation.service.ts`) that must be executed by a platform maintainer through a supervised one-off privileged call inside the Management environment.
- The call must come from the mutation's original principal (`principal_type`/`principal_id`), supply the row's current `fencing_epoch` as `expectedFencingEpoch`, and include evidence whose `observedAt` falls between the row's `completed_at` and the database clock (plus skew allowance).
- If ground truth shows the activation took effect, reconcile to `succeeded`; otherwise roll the gateway route back to the previously active release and reconcile to `failed_terminal`.
- Never delete the row or overwrite `status` directly with SQL: that bypasses the audit event, the fencing-epoch CAS, and the evidence window, and can mask a real split-brain.
- Once no unresolved rows remain, start Management normally; the startup gate passes and the background recovery worker resumes its normal polling.

## Notes

- This stack is for self-host bootstrap and small deployments. It borrows Pigsty/PGEXT packages for extension coverage, but it does not replace a full Pigsty HA production deployment.
- The generated quickstart creates `pgsodium` and `supabase_vault`; the manual `.env.example` template keeps both disabled until stable keys are supplied.
- `supabase_vault` has its own preload-time key loader. If you enable it, either set `VAULT_KEY` / `VAULT_KEY_FILE` explicitly or let it reuse the pgsodium key sources by leaving those variables empty.
- `BASE_DOMAIN` is derived from `PUBLIC_URL` by `init-env.py`. Override it manually if you need a different wildcard routing suffix.
- `init-env.py --output .env` replaces the file atomically with mode `0600`; reruns preserve the existing independent `SUPAOAUTH_BFF_SIGNING_SECRET` unless an explicit replacement is supplied.
- Legacy encryption material lives only in the `0600` one-shot file named by `LEGACY_SECRETS_MIGRATION_FILE`; a rerun without a key preserves a non-empty recovery file until migration succeeds.
