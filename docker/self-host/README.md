# SupaCloud Docker Compose Self-Host

This stack is isolated from `docker/dev` and is intended for one-command self-host bootstrapping.

## Included services

- PostgreSQL 18
- Kong 3.6
- GoTrue
- PostgREST
- SupaCloud Management API
- SupaCloud Bun Edge Runtime

## Packaged PostgreSQL extensions

The PostgreSQL image preinstalls these common extensions:

- `uuid-ossp`
- `pgcrypto`
- `pg_stat_statements`
- `pg_cron`
- `pgaudit`
- `pgvector`
- `postgis`
- `hypopg`
- `pg_stat_kcache`
- `wal2json`

It also sets:

- `shared_preload_libraries=pg_stat_statements,pg_cron,pgaudit`
- `cron.database_name=postgres`
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

## Notes

- This stack is for self-host bootstrap and small deployments. It does not replace the Pigsty-based production path.
- `BASE_DOMAIN` is derived from `PUBLIC_URL` by `init-env.py`. Override it manually if you need a different wildcard routing suffix.
- Kong gzip is disabled by default to avoid the HTTP/2 proxy corruption issue already seen on API traffic.
