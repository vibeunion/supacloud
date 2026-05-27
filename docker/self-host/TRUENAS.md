# TrueNAS SCALE Custom App Guide

This guide is for running the published SupaCloud PostgreSQL image on **TrueNAS SCALE** as a **Custom App**.

## When to use this

Use this path when you want:

- the SupaCloud PostgreSQL image from GHCR
- the Pigsty/PGEXT extension set already baked into the image
- optional FerretDB + DocumentDB support on the same PostgreSQL instance

Do **not** use the TrueNAS catalog PostgreSQL app if your goal is to reuse this image's extension set. The catalog app and this image are different deployment paths.

## Recommended image

Use a released tag instead of `latest`.

```text
ghcr.io/zuohuadong/supacloud/postgres:0.23.0
```

The package is public, so no GHCR credentials are required for normal pulls.

## Custom App form values

Repository:

```text
ghcr.io/zuohuadong/supacloud/postgres
```

Tag:

```text
0.23.0
```

Container port:

```text
5432/TCP
```

Persistent storage mount:

```text
/var/lib/postgresql
```

Required environment variables:

```text
POSTGRES_PASSWORD=<strong password>
```

Common optional environment variables:

```text
POSTGRES_USER=postgres
POSTGRES_DB=postgres
TZ=Asia/Shanghai
```

## Optional FerretDB

Enable these only when you also want MongoDB wire protocol compatibility:

```text
ENABLE_FERRETDB=true
FERRETDB_USER=ferretdb
FERRETDB_PASSWORD=<another strong password>
FERRETDB_DATABASE=postgres
```

When FerretDB is enabled, also expose:

```text
27017/TCP
```

`FERRETDB_DATABASE` defaults to the main PostgreSQL database on purpose. `documentdb` depends on `pg_cron`, and `pg_cron` can only be created in the database selected by `cron.database_name`.

## Optional pgsodium and Vault

Enable these only on a fresh PostgreSQL data directory and only after deciding how the key will be stored:

```text
ENABLE_PGSODIUM=true
PGSODIUM_KEY=<64-character-hex-key>
PGSODIUM_ENABLE_EVENT_TRIGGER=off
```

Generate a key with:

```bash
openssl rand -hex 32
```

If your TrueNAS deployment can mount a secret file into the container, prefer:

```text
ENABLE_PGSODIUM=true
PGSODIUM_KEY_FILE=/run/secrets/pgsodium_key
PGSODIUM_ENABLE_EVENT_TRIGGER=off
```

To create Supabase Vault as well:

```text
ENABLE_SUPABASE_VAULT=true
```

`ENABLE_SUPABASE_VAULT=true` requires `ENABLE_PGSODIUM=true`. The pgsodium key must remain stable across restarts and app upgrades; changing it without a planned migration can make encrypted values unreadable.

## Important initialization rule

Set all required environment variables **before the first start**.

This image uses init scripts to:

- create and preload required PostgreSQL extensions
- optionally create the FerretDB role
- optionally create the `documentdb` extension
- optionally preload and create `pgsodium`
- optionally create `supabase_vault`

`pgsodium` and `supabase_vault` packages are present in the image, but they are not bootstrapped by default in self-host mode. When `ENABLE_PGSODIUM=true`, the image preloads `pgsodium`, uses the bundled `pgsodium_getkey` script, and creates the extension during first initialization.

If TrueNAS already initialized the app data directory, changing `ENABLE_FERRETDB` later will not replay those init scripts. In that case, use a fresh data directory or apply the role and extension changes manually.

## Minimal deployment checklist

1. Create a new Custom App.
2. Set the image repository and fixed tag.
3. Add a host path or dataset mount for `/var/lib/postgresql`.
4. Set `POSTGRES_PASSWORD`.
5. Optionally add the FerretDB variables and `27017/TCP`.
6. Optionally add the pgsodium variables before first start.
7. Start the app on an empty data directory.

## Verification after first start

Basic PostgreSQL readiness:

```bash
pg_isready -h <truenas-app-ip> -p 5432 -U postgres -d postgres
```

Basic extension check:

```sql
SELECT extname
FROM pg_extension
ORDER BY extname;
```

When FerretDB is enabled, verify the port is listening on `27017` and test it with a MongoDB-compatible client.
