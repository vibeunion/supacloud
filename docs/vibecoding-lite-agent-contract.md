# Vibecoding Lite agent contract

[English](vibecoding-lite-agent-contract.md)

Agents reach a usable isolated backend through the SupaCloud contract that
already exists: one database per project, a schema edited in maintained
sources, an API the anon key can call, and one JSON handoff. This path does
not replace Management API, GoTrue, PostgREST, Realtime, or the migration
ledger.

## One worktree, one database

Lite binds one project directory to one database under that project's
`.supacloud-lite` state. `handoff` reads the project secrets and the configured
URL. It does not open a second database and it does not apply SQL. `start`
serves that same project. Isolation stays one database per project. Role names
stay `anon`, `authenticated`, and `service_role`. Cluster login roles
`supabase_auth_admin` and `supabase_admin` are not renamed.

## JSON handoff

After `start --json`, stdout is one JSON object and nothing else. `handoff`
and `keys --json` print the same shape and exit. The object has exactly these
fields:

| Field | Contents |
| --- | --- |
| `url` | Project API URL |
| `anon_key` | Anon API key (`role` claim `anon`) |
| `next` | Commands the agent runs next |

```bash
supacloud-lite start --json --project-dir .
supacloud lite handoff --project_dir .
```

```json
{
  "url": "http://127.0.0.1:54321",
  "anon_key": "<anon-jwt>",
  "next": [
    "supacloud-lite migrate --project-dir .",
    "supacloud-lite complete --project-dir . --module-file supabase/db/modules.ts"
  ]
}
```

The `supacloud lite` adapter returns that JSON as the tool result for
`handoff` and for `keys --format json`. It does not wrap the payload in a
status line.

### No service_role key in agent context

The handoff never includes the `service_role` key. `start --json`, `handoff`,
and `keys --json` reject `--service-role`. The `supacloud lite` tool has no
flag that forwards `--service-role`, and it refuses to return a captured
`service_role` JWT.

`supacloud-lite keys --service-role` remains an operator command for a server
that must bypass RLS. Do not print that output, paste it into a prompt, or
pass it to a model. The anon key is the client credential.

## Schema and seed

Development schema and seed changes are additive forward files under
`supabase/migrations`. Edit the maintained module manifest and SQL sources,
then apply them with `supacloud-lite migrate`. That command is the existing
Lite migration ledger.

Do not give the agent a side path that applies ad-hoc SQL, dumps schema
outside the ledger, or mutates production. `lite db_pull` still writes review
drafts outside `supabase/migrations` for operators. `lite db_diff` is the same
kind of inspection. Neither command is in the handoff `next` list. Production
schema and data writes are not part of this contract. `database execute` and
`database query` are not the authoring path.

Seed data for the agent path belongs in a forward migration. `supabase/seed.sql`
remains the existing operator replay file used by migrate and reset. It is not
a second ledger and it is not permission to run arbitrary SQL.

`migrate`, `complete`, `db check`, `db reset` and `auth create-user` open the
project database themselves, and opening it takes the data-directory lock. They
fail with `database data directory is already in use` while `start` holds it,
which is the one-process-per-database rule, not a defect. Stop the Lite process
before running them, and read the handoff `next` list as work for the stopped
window rather than for the running server. The anon key is derived from the
project secrets and the URL from the same `--host`/`--port` flags, so both
survive the restart.

## RLS completion

Agents are not done when the existing RLS checks are skipped.

`supacloud-lite complete` loads the database module manifest and runs the same
read-only reconcile as `supacloud-lite db check` (`@supacloud/db` catalog
reconcile, including `rls-disabled`). It needs the same exclusive database
access as `migrate`, so run it with the Lite process stopped. The command exits
non-zero unless that reconcile ran against at least one owned table and reported
no error. A
missing manifest, a manifest with no owned tables, or a database that could
not be read is `rls_checks: "skipped"` and `done: false`. `skipped_is_done` is
always false.

`supacloud db check` still allows an offline source lint. Its JSON now includes
`completion`. When the catalog reconcile did not run, `ok` can stay true for
the source lint and `completion.done` is false. That exit code is not
completion.

`supacloud app verify-plan` does not execute the checks. Its `completion`
object lists the required commands and sets `skipped_is_done` to false.
Stopping after the focused unit tests, without those commands, is not done
for a backend change.

On a hosted project, `database database_lint` remains the existing linter that
reports `no_rls`. This contract does not add a second linter or policy engine.

## Production MCP

Production MCP stays plan-only. The operations surface still exposes read
tools and `supacloud.plan_pitr_restore`. It does not gain schema or data write
tools. Developer MCP stays read-only, and its route smoke tool stays outside
production. See [Optional AI Operations MCP](mcp-ai-operations.md).

## GraphQL and Squawk

Lite `/graphql/v1` executes Hasura-shaped reads as SQL in the caller's
transaction: `query_root`, `where`, `order_by`, `limit`, and foreign-key
fields named the way pinned Postrust v3.4.0 names them. PostgreSQL `GRANT`
and RLS apply. Lite does not call `pg_graphql` or `graphql.resolve` for this
route, and it does not embed Postrust.

Mutations, aggregates, subscriptions, relationship filters, and Relay
`*Collection` documents are rejected. `db-pre-request` does not run. Those
limits are listed on `LITE_GRAPHQL_CONTRACT`. A hosted read document of the
supported shape is a Lite document. `doctor --json` reports the route as
supported once a database is open, and unverified before that.

Squawk is not added. The migration check remains the existing
`@supacloud/db` lint plus the single migration ledger. Squawk would be
admissible only as an optional Apache-2.0 linter invoked as a check. It must
not become an executor, migrator, or policy engine.

## Lite compared with the full GoTrue and extension set

This contract does not flatten those differences.

| Area | Lite agent path | Full platform path |
| --- | --- | --- |
| Auth process | In-process Auth in the Lite Bun process. Email/password, sessions, and bcrypt are covered by Lite tests. OTP, magic link, anonymous users, OAuth, and MFA stay experimental. | Stock GoTrue v2.198.0 as its own process, including its embedded auth migrations and `supabase_auth_admin`. |
| API | Lite's PostgREST-compatible handler in the same process. | PostgREST on the project database. This contract does not retarget that process. |
| Realtime | Lite realtime. RLS DELETE events in V1 go to `service_role` subscribers only. | Management API proxies `wss://<project-api-host>/realtime/v1/websocket` to the Rust Realtime gateway. `anon` and `authenticated` `postgres_changes` go through `realtime.subscription` and `realtime.apply_rls`. |
| Extensions | PGlite bundles its Lite set (`pgvector`, experimental PostGIS, `pg_textsearch`, `pgmq`). Lite GraphQL reads do not need `pg_graphql`. `pg_cron` and other native extensions need an operator PostgreSQL. | The platform image set, including test and check extensions such as `pgtap` and `plpgsql_check` where that image installs them. Postrust v3.4.0 serves hosted `/graphql/v1`. |
| Control plane | No Management API, no project provision API, no Pigsty HBA edits. | Management API, one database per project, plan-only production MCP. |
| Privileged key | Operator-only local print. Absent from the agent handoff. | Stored for the project. Not forwarded into model context by the handoff. |

A hosted project still uses the full create and credential flow. Lite is the
local agent backend, not a second control plane and not a production deploy.
The FA deployment root is `supacloud/fa` and is outside this git tree.
