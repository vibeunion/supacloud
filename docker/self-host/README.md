# SupaCloud Docker Compose Self-Host

This stack is isolated from `docker/dev` and is intended for one-command self-host bootstrapping.

## Included services

- PostgreSQL 18
- Kong 3.6
- GoTrue
- PostgREST
- SupaCloud Management API
- SupaCloud Bun Edge Runtime
- FerretDB MongoDB wire protocol gateway, optional through the `ferretdb` Compose profile

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
- `pgjwt`
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

## Quick start

Generate a production-grade `.env`:

```bash
cd docker/self-host
python3 init-env.py --public-url https://api.example.com --studio-url https://studio.example.com > .env
```

Then boot the stack:

```bash
docker compose up -d --build
```

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

## Optional pgsodium runtime

`pgsodium` is disabled by default because it requires a stable server key before PostgreSQL starts. To enable it on a fresh database volume, set:

```bash
ENABLE_PGSODIUM=true
PGSODIUM_KEY=<64-character-hex-key>
PGSODIUM_ENABLE_EVENT_TRIGGER=off
```

Generate a key with:

```bash
openssl rand -hex 32
```

Prefer mounting the key as a secret file and setting `PGSODIUM_KEY_FILE` when your runtime supports it. `PGSODIUM_KEY` is provided as a simple fallback for Compose and Custom App deployments.

To create Supabase Vault on top of the same runtime, also set:

```bash
ENABLE_SUPABASE_VAULT=true
```

`ENABLE_SUPABASE_VAULT=true` requires `ENABLE_PGSODIUM=true`. The key must stay stable across restarts and upgrades; rotating it without a planned migration can make encrypted data unreadable.


## Rolling back pgsodium

If you enabled pgsodium on a fresh volume and need to disable it:

1. Stop the stack: `docker compose down`.
2. Remove or rename the `postgres-data` volume to start fresh: `docker volume rm supacloud_postgres-data`.
3. Set `ENABLE_PGSODIUM=false` and `ENABLE_SUPABASE_VAULT=false` in `.env`.
4. Start the stack again: `docker compose up -d --build`.

**Important**: Once pgsodium has been initialized, encrypted data (including Vault secrets) depends on the original key. Starting over with a new volume means that data is lost. If you need to keep existing data, do **not** remove the volume. Instead, keep the same `PGSODIUM_KEY` or `PGSODIUM_KEY_FILE` value and simply stop using the `pgsodium` and `vault` schemas. The extension stays loaded in `shared_preload_libraries` until you rebuild PostgreSQL with `ENABLE_PGSODIUM=false` on a fresh volume.

## Notes

- This stack is for self-host bootstrap and small deployments. It borrows Pigsty/PGEXT packages for extension coverage, but it does not replace a full Pigsty HA production deployment.
- `pgsodium` and `supabase_vault` stay installed but are not created automatically in self-host mode. Set `ENABLE_PGSODIUM=true` only after providing a stable key through `PGSODIUM_KEY_FILE` or `PGSODIUM_KEY`.
- `BASE_DOMAIN` is derived from `PUBLIC_URL` by `init-env.py`. Override it manually if you need a different wildcard routing suffix.
- Kong gzip is disabled by default to avoid the HTTP/2 proxy corruption issue already seen on API traffic.
