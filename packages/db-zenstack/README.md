# @supacloud/db-zenstack

The required ZenStack adapter for model compilation and `createZenStackDatabase`.

Install `@supacloud/model-tooling` for the development-only `supacloud-model`
commands. This adapter keeps the Bun SQL runtime path separate from the
ZenStack CLI's PostgreSQL introspection driver.

`@supacloud/db` re-exports `@supacloud/db/zenstack` and `@supacloud/db/model` from this package so existing imports keep working. The selected Vibecoding stack installs this adapter together with `@supacloud/db`.

`@supacloud/db` catalog, RLS, and command-receipt code does not import this adapter.
