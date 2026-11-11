# @supacloud/db-zenstack

The required ZenStack adapter for model compilation and `createZenStackDatabase`.

`@supacloud/db` re-exports `@supacloud/db/zenstack` and `@supacloud/db/model` from this package so existing imports keep working. The selected Vibecoding stack installs this adapter together with `@supacloud/db`.

`@supacloud/db` catalog, RLS, and command-receipt code does not import this adapter.
