# Supabase import lab

This is the first local slice of a Supabase migration and compatibility lab.
It imports a Supabase project directory into SupaCloud Lite and prints a
checklist. It does not deploy, publish, or claim a live or production cutover.

The older `supacloud database migration_import` command only plans Hasura and
Nhost SQL. It does not apply SQL and does not import Auth, Storage, or
Functions. This lab is the Supabase-shaped path Lite can run on one machine.

## Command

From the repository:

```sh
bun run --cwd packages/supacloud-lite src/cli.ts import \
  --from ./my-supabase-project \
  --project-dir ./lite-target \
  --json

bun run --cwd packages/supacloud-lite src/cli.ts compat --json
```

`--from` and `--project-dir` may be the same directory. A different destination
receives copies of `config.toml`, `migrations`, `seed.sql`, `functions`, and
`supabase/import`. Existing different files are left in place unless `--force`
is passed. Symbolic links are refused.

`--report <file>` also writes the JSON report. The report always includes
`"deployed": false`.

## What the import reads

```text
supabase/config.toml
supabase/migrations/*.sql
supabase/migrations/<version>/migration.sql
supabase/seed.sql                         optional row data, applied by Lite
supabase/functions/<name>/index.ts
supabase/import/data.sql                  optional extra data SQL, applied once
supabase/import/auth-users.json           optional local Auth users
supabase/import/storage/<bucket>/<object>
supabase/import/expectations.json         optional row, ACL, and function checks
```

`auth-users.json` is `{ "users": [{ "email", "password", "email_confirm": true }] }`.
The file is tightened to mode `0600`. Passwords are not printed. At most 32
users are accepted, and each password must be one line of 6 to 72 characters.

`expectations.json`:

```json
{
  "data": [{ "table": "notes", "rows": 1 }],
  "acl": [{ "table": "notes", "anon_rows": 0, "service_rows": 1 }],
  "functions": [{ "name": "hello", "status": 200, "body": "{\"ok\":true}" }]
}
```

Table names are unqualified public identifiers. Counts must be integers from
0 through 100. Storage buckets named in the object tree must already be
declared under `[storage.buckets.<id>]`.

`import/data.sql` is executed once and recorded in
`supabase_migrations.seed_files`. A later edit is not applied and the data row
stays unchecked. Put further changes in a new migration.

## Checklist

| Row | Checked only when |
|---|---|
| config | `config.toml` parses and every declared bucket exists after startup |
| migrations | every migration file version and SQL bytes match `supabase_migrations.schema_migrations` |
| data | `expectations.json` row counts match a `select` through the local API |
| acl | anon and service-role row counts match the ACL expectations |
| objects | service-role upload/download bytes match, and a private bucket's public URL is not HTTP 200 |
| functions | each loaded function returns the expected status and body |
| auth | each imported user accepts a password grant |

A missing input stays unchecked with a blocker and does not fail the command.
A present input that cannot be shown to match stays unchecked and the command
exits 1. Rows are not marked passed because a file was copied.

## Version matrix

`compat` and `import` both print five rows:

| Component | Declared pin | When the row can be checked |
|---|---|---|
| supabase-js | 2.118.0 | the installed package is exactly 2.118.0 and this import's checklist passed through that client |
| CLI | 2.122.0 | never, by this command. It does not execute the official Supabase CLI |
| Realtime | v2.150.0 | never, by this command. It does not open a WebSocket |
| Storage | repository-owned | never. Object bytes are on the objects checklist. This repo does not pin an upstream storage-api image |
| Edge Functions | 0.37.2 (`@supacloud/edge-runtime`) | never, by this command. Function files run in-process in Lite. The hosted edge-runtime process is not started |

`compat` by itself leaves every row unchecked. Printing a pin is not a passing
check.

## Limits

This slice runs on Lite's local engine (PGlite unless `--engine native` is
selected). It does not start the multi-project control plane, and it does not
import hosted Supabase credentials, Analytics, or preview branches. SQL files
are capped at 2 MiB. Each storage object and function file is capped at 1 MiB,
with at most 64 objects and 32 functions. Identity modules are not loaded.
Webhooks and background runtime services stay off.

Not deployed.
