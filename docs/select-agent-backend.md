# Agent backend implementation

## Scope and boundaries

Agents should author, inspect and operate a project's backend using the
existing deployment authority. Application-user tools must not borrow
administrator credentials. Production migration, deployment and live acceptance
are separate from implementation and local tests.

Non-goals: automatic production migration, a second deployment orchestrator,
replacing established Drizzle sources, or treating unavailable telemetry as healthy.

## Capability map

| Area | SupaCloud implementation | Acceptance boundary |
| --- | --- | --- |
| Declarative schemas | Allowlisted official CLI generate/sync and pg-delta diff; sync generates without applying by default | Requires a compatible upstream CLI; not a replacement for an existing Drizzle source |
| Configuration | Project-bound `config_pull`, preview first, explicit local overwrite confirmation | Reads upstream Supabase configuration, not SupaCloud Management settings |
| App-user MCP | Project JWT verification, exact user-token forwarding to PostgREST, protected-resource discovery | Existing project OAuth issuer required for discovery; real client login and RLS replay remain a deployment gate |
| Compute | Delivery declarations, release validation, allocation budget, systemd CPU/memory enforcement and readiness checks | Shared Linux host/process isolation, not a private VM or arbitrary container platform |
| Native local stack | Upstream prepare/start/status/stop/destroy adapter, opt-in alpha | Upstream binaries, OS support and per-directory isolation need runtime acceptance |
| Log SQL | One read-only SQL query over a bounded, redacted project log snapshot | A SQLite-compatible subset, not PostgreSQL access to an unlimited log warehouse |
| Advisors and locks | Request-status error samples, database observations, bounded project connection/blocker view | Missing or incomplete evidence is unknown; no automatic repairs |
| SQL notebooks | Owner/project-scoped storage, revisions, import/export and persistent local bindings | Real PostgreSQL CRUD still needs integration acceptance |
| Explorer | Searchable, paginated public-table catalog opening quoted, limited SQL drafts | No auto-execution; not a claim of upstream Explorer feature parity |
| Lite authoring | Read-only live inspection, exact history matching, disposable-shadow replay, explicit baseline | Supported catalog subset only; advanced objects fail closed when detected |

## Declarative schemas and config

Keep an existing project's schema authority unchanged. New projects can delegate
initialization to a compatible official CLI; the adapter does not overwrite an
existing `config.toml`. The verified upstream template enables pg-delta, but this
is not a guarantee about an arbitrary installed CLI version.

```bash
supacloud-cli supabase version
supacloud-cli supabase init --workdir .
supacloud-cli supabase db_schema_declarative_generate --workdir . --db_url "$SUPACLOUD_DB_URL"
supacloud-cli supabase db_schema_declarative_sync --workdir . --name add_accounts --strict_coverage
supacloud-cli supabase db_diff --workdir . --diff_engine pg-delta --name add_accounts
supacloud-cli supabase config_pull --workdir . --ref upstream-project
supacloud-cli supabase config_pull --workdir . --ref upstream-project --dry_run=false --yes
```

`generate` uses an explicit DSN or the upstream linked project. Existing schema
files require `--overwrite`. `sync` supplies `--no-apply` unless `--apply` is
explicit; the generated migration still needs review. The declarative commands
default to `--experimental`; `--experimental=false` omits it. Remote migration
application continues through the existing SupaCloud `supabase push` dry-run,
approval and receipt flow.

`config_pull` reads the official Supabase control plane. Its project ref must
match a configured SupaCloud context when one is present. It defaults to
`--dry-run`; changing the local file requires both `--dry_run=false` and `--yes`,
with `--force` only for an explicitly reviewed conflict. This does not migrate
SupaCloud-only settings or secrets between environments.

The child environment removes inherited credential-like variables and automatic
confirmation flags. Forwarding `SUPABASE_ACCESS_TOKEN` requires the explicit
`SUPACLOUD_FORWARD_SUPABASE_ACCESS_TOKEN=1` opt-in. The official CLI may still
read its own saved login or dotenv files: this adapter is not a credential
sandbox. Use a reviewed work directory and do not commit secrets.

## Local stacks

```bash
supacloud-cli supabase stack_start --workdir ./project-a
supacloud-cli supabase stack_status --workdir ./project-a
SUPACLOUD_ENABLE_NATIVE_STACK=1 supacloud-cli supabase stack_prepare --workdir ./project-b --runtime native
SUPACLOUD_ENABLE_NATIVE_STACK=1 supacloud-cli supabase stack_start --workdir ./project-b --runtime native --preparation on-demand --eager
supacloud-cli supabase stack_stop --workdir ./project-b
supacloud-cli supabase stack_destroy --workdir ./project-b --confirm_destroy --yes
```

Start/prepare explicitly default to Docker, never upstream `auto`. Native mode is
alpha and disabled unless `SUPACLOUD_ENABLE_NATIVE_STACK=1`. Upstream owns the
directory-local service processes, downloads, ports and state. Stop is not
destroy; destroy requires two confirmations and can remove local data. Validate
two directories concurrently, stop/restart recovery and native extension support
before adopting this mode for daily work. SupaCloud Lite's existing PGlite/native
engine is a separate runtime, not this upstream full-stack mode.

## Application-user MCP

Use the configured project's API origin and
`POST /mcp/app/projects/<ref>`. This is separate from administrator/developer MCP.
It accepts an authenticated project-user JWT with a nonempty subject, rejects
anonymous, privileged and cross-project credentials, and sends the exact user
JWT to that project's loopback PostgREST.

Tools are read-only: `app.read_table` returns at most 100 rows, and
`app.call_readonly_rpc` uses GET. PostgreSQL grants, RLS and RPC behavior remain
the authorization boundary. Audit views and `SECURITY DEFINER` functions; token
forwarding alone cannot repair unsafe application grants.

Discovery lives at
`/.well-known/oauth-protected-resource/mcp/app/projects/<ref>`. Unauthorized
responses advertise that metadata through `WWW-Authenticate`. Metadata uses
the existing enabled project/owner OAuth issuer, never an invented fallback.
The resource origin comes from the project's API URL; an operator may set
`SUPACLOUD_APP_MCP_ORIGIN` to a public HTTPS origin (HTTP is loopback-only).
Missing OAuth configuration returns unavailable.

Requests are bounded to 64 KiB, Data API responses to 1 MiB, and fetches have a
timeout, disallow redirects and use `no-store`. Configure the existing OAuth
client/login flow, then test two users with disjoint RLS-visible rows, an expired
token, an anonymous token, a service-role token and a different project before
enabling a real agent client.

## Long-lived Compute

Add resources to a delivery target without changing the application release and
activation workflow:

```json
{
  "version": 1,
  "runtime": {
    "processIsolation": true,
    "durableQueue": false,
    "capabilities": []
  },
  "targets": [{
    "name": "api",
    "kind": "api",
    "modules": ["orders"],
    "compute": { "cpuLimit": 0.5, "memoryLimitMiB": 256 }
  }]
}
```

CPU is 0.1-64 in 0.1 increments; memory is 64-262144 MiB. Compute implies process
isolation and cannot be combined with a queue execution group on the same
target. Resources are bound into the topology digest and validated again during
archive intake and release reads. HTTP services and ordinary workers use
systemd CPU quota, memory maximum, zero swap and control-group shutdown. They
have no total service-lifetime timeout; readiness/startup checks remain bounded.

The operator-owned `SUPACLOUD_APPLICATION_WORKER_BUDGET_JSON` residual budget is
shared by Compute targets and maximum queue-worker reservations. Reserve host
headroom first. Compute reserves CPU/memory but does not independently limit
ordinary service database pools: account for those connections in the residual
budget and application pool configuration.

Services run as the existing project Linux user on a shared host. This is not a
private Linux VM, a root shell or a package-install sandbox. Release contents,
secrets and network permissions keep their existing boundaries. Before Linux
acceptance, verify the systemd properties and actual cgroup files, over-budget
rejection, crash/restart, graceful shutdown and a service running beyond Edge
Function duration limits.

## Operations and notebooks

Developer MCP adds `supacloud.query_project_logs_sql` and
`supacloud.get_connection_locks`. Project credentials cannot override their
project scope. For example:

```sql
SELECT service, severity, count(*) AS entries
FROM project_logs
GROUP BY service, severity
ORDER BY entries DESC
LIMIT 50;
```

Log SQL accepts one SELECT (16 KiB maximum), with no joins, subqueries, writes or
unapproved functions. The source is at most 1000 records from the last hour and
16 MiB; output is at most 500 rows and 2 MiB. Results state the SQL dialect and
source/result truncation. Sensitive fields and common credential patterns are
redacted, but arbitrary application secrets cannot be guaranteed detectable.
Malformed, oversized or cross-project upstream records fail closed.

Advisors at `/v1/projects/<ref>/advisors` measure HTTP 5xx divided by observed
request status codes, not error-severity log counts or all traffic. Missing
coverage, failed collection and a full source sample are unknown. The default
warning threshold is 5%. Database observations include project client
connections relative to the cluster maximum, blockers, unused-index candidates
and public-table RLS. These are observations, not automatic drop/repair advice.

The `/advisors/connections` view returns at most 100 project-database sessions
with wait events and blocker PIDs, no SQL text, and an explicit truncation flag.
The console keeps usable Advisor data when connection collection independently
fails and clears stale data on project changes.

Notebooks at `/v1/projects/<ref>/notebooks` are scoped to project and Management
principal (`actor type:id`); shared credentials therefore share notebooks.
Names are unique per owner, SQL is limited to 1 MiB UTF-8, and list pages contain
at most 200 summaries. Updates and deletes require the observed revision;
stale revisions return 409. The editor preserves local SQL after conflicts,
loads into a new tab, remembers notebook bindings across remounts, and exports
the current draft as `.sql`. Local draft storage contains no query results.
Imports, table selection and notebook loading do not execute SQL automatically.

## Lite drift and baseline

```bash
supacloud-lite db diff
supacloud-lite db pull captured_schema
# After reviewing the draft and taking a snapshot:
supacloud-lite db pull captured_schema --baseline
```

Inspection does not initialize the live backend or apply pending migrations.
Applied history must match the supplied migration files exactly. A disposable
shadow replays migrations without seed, applies the generated delta and compares
the supported catalog before emitting it. Detected unsupported view, function,
trigger, policy, grant, RLS or non-append enum changes are rejected with guidance
to use the official pg-delta adapter. This is not complete PostgreSQL catalog
coverage.

CLI pull defaults to `.supacloud-lite/schema-drafts`, outside executable
migrations, and does not change the ledger. `--baseline` is explicit: it records
already-present DDL without executing it and publishes the migration only after
the ledger commit is confirmed. Files are created without overwriting existing
files. Library callers control `migrationsDir` and must likewise choose a draft
directory when `baseline` is false.

If baseline reports an uncertain outcome, stop startup/migration attempts. Keep
the `.sql.pending` file, snapshot the state, and inspect the ledger version,
name and exact SQL. If a matching ledger row exists, publish exactly that pending
file without overwriting a different file. If no row exists, retain the draft
outside migrations and retry through the controlled baseline path. Never guess
commit state, delete the ledger row or replay the captured DDL against the
already-changed database. File publication is not a cross-filesystem/DB atomic
transaction or a guarantee of crash-proof fsync durability.

## Acceptance

```gherkin
Scenario: User authorization
  Given an authenticated user token for project A
  When App MCP reads project A
  Then the exact user token reaches its Data API
  And project B, anonymous tokens and privileged tokens are rejected

Scenario: Safe authoring
  Given local declarative SQL and configuration
  When a migration is generated or configuration is pulled
  Then no production migration is applied
  And existing local configuration requires an explicit conflict decision

Scenario: Notebook concurrency
  Given two editors holding the same notebook revision
  When one saves and the other saves its stale revision
  Then the second receives a conflict without losing its local SQL

Scenario: Operational evidence
  Given unavailable database or request telemetry
  When Advisors are read
  Then affected measurements are unknown, never healthy
  And logs and locks remain scoped to one authorized project

Scenario: Runtime isolation
  Given two local project directories and a limited application service
  When their runtimes start
  Then local state and ports are independent
  And deployment readiness verifies actual CPU and memory enforcement
```

## Verification and remaining gates

Local focused tests cover CLI argument/credential boundaries, user-MCP
authorization, gateway routes, Compute plan/release/runtime validation, bounded
log SQL, telemetry parsing, Advisor rates, notebook routes and editor races.
Lite tests replay actual PGlite state, including non-mutating drafts, baseline
restart and rejection of unsupported drift.

Desktop and 390px browser checks use deterministic local API fixtures. They
verify rendered Explorer/Advisors behavior, not a deployed backend. No production
credentials, host changes or database migrations are part of this implementation.
Required external acceptance remains:

1. A pinned official CLI with declarative/config/native stack commands, including
   two-directory isolation and restart.
2. A real OAuth agent login and per-user/cross-project PostgREST RLS replay.
3. Linux systemd/cgroup enforcement and allocation concurrency.
4. Real Management PostgreSQL notebook CRUD, ownership and conflicts.
5. Project-tagged VictoriaLogs data and native PostgreSQL schema authoring.

Implementation, PR merge, deployment and online acceptance are separate states.
Do not mark these external gates passed based on unit tests or browser fixtures.

## Upstream references

The CLI contract was inspected at upstream commit
`66ccc6f63a9a26b29c368698994a0843d23b80be`:

- [Declarative sync](https://github.com/supabase/cli/blob/66ccc6f63a9a26b29c368698994a0843d23b80be/apps/cli/src/commands/db/schema/declarative/sync/sync.command.ts)
- [Project initialization template](https://github.com/supabase/cli/blob/66ccc6f63a9a26b29c368698994a0843d23b80be/apps/cli/src/shared/init/project-init.templates.ts)

Official Select announcement and Explorer rollout dates were not independently
verified. The quoted October 12 rollout is not a SupaCloud release promise.
