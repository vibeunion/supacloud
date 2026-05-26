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
- `supabase_vault` from the Pigsty `vault` package
- `pgjwt`
- `pgsodium`
- `wal2json`

It also packages these PostgreSQL libraries and optional extensions:

- `supautils`
- `pg_plan_filter`, loaded as `plan_filter`
- `documentdb`, created only when the FerretDB profile is enabled

It also sets:

- `shared_preload_libraries=pg_stat_statements, pg_cron, pgaudit, pg_net, pg_stat_kcache, plan_filter, pg_documentdb, pg_documentdb_core`
- `cron.database_name=${POSTGRES_DB}`
- `wal_level=logical`

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

## Optional FerretDB profile

FerretDB is disabled by default. To expose the MongoDB wire protocol on top of the same PostgreSQL container and `postgres-data` volume, enable it before the first database initialization:

```bash
ENABLE_FERRETDB=true COMPOSE_PROFILES=ferretdb docker compose up -d --build
```

The profile creates a separate FerretDB database user and installs `documentdb` in `${FERRETDB_DATABASE}`. By default `${FERRETDB_DATABASE}` is the same as `${POSTGRES_DB}` because `documentdb` depends on `pg_cron`, and `pg_cron` can only be created in the database configured by `cron.database_name`. The MongoDB wire protocol endpoint is exposed on `${FERRETDB_PORT}` (default `27017`).

If `postgres-data` already exists, Docker entrypoint init scripts will not run again. Enable FerretDB on a fresh volume or create the FerretDB role/database and `documentdb` extension manually.

## Notes

- This stack is for self-host bootstrap and small deployments. It borrows Pigsty/PGEXT packages for extension coverage, but it does not replace a full Pigsty HA production deployment.
- `BASE_DOMAIN` is derived from `PUBLIC_URL` by `init-env.py`. Override it manually if you need a different wildcard routing suffix.
- Kong gzip is disabled by default to avoid the HTTP/2 proxy corruption issue already seen on API traffic.
