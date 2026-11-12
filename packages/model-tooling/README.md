# @supacloud/model-tooling

This package owns the development-only model adoption and migration toolchain.
It provides the `supacloud-model` binary and keeps ZenStack CLI, Prisma and the
PostgreSQL `pg` driver out of the application runtime dependency graph.

Application hosts continue to use the Bun SQL adapter from
`@supacloud/db-zenstack`. The `pg` dependency here exists only because the
upstream ZenStack PostgreSQL introspector requires it while creating a review
candidate with `supacloud-model pull`.
