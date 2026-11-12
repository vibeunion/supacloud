# @supacloud/model-tooling

This package owns the development-only model adoption and migration toolchain.
It provides the `supacloud-model` binary and keeps database access in the
Management API. Application hosts continue to use the Bun SQL adapter from
`@supacloud/db-zenstack`; this package does not ship `pg`, Prisma or the
ZenStack CLI introspection driver.

For managed projects, set `SUPACLOUD_API_URL`, `SUPACLOUD_API_TOKEN` and
`SUPACLOUD_PROJECT_REF` and run `supacloud-model pull --candidate
output/database-audit/model.zmodel`. The command uses the Management API's
project database binding, so the CLI never receives a PostgreSQL URL or needs
an inbound database port. A candidate is review-only and is never promoted
automatically.

Compile and check remain offline operations: `supacloud-model generate` and
`supacloud-model check` read the maintained ZModel file only. For forward SQL,
use the remote, digest-bound workflow from the SupaCloud CLI:

```sh
supacloud db plan --dir supabase/migrations
supacloud db apply --dir supabase/migrations --approved_digest <reviewed-digest>
```

Both commands send migration bytes to the Management API, which owns the
project database binding and ledger. They do not require `DATABASE_URL`, an
inbound PostgreSQL port, or a local database driver.
