# @supacloud/db-zenstack

Optional ZenStack adapter for model compilation and `createZenStackDatabase`.

`@supacloud/db` re-exports `@supacloud/db/zenstack` and `@supacloud/db/model` from this package so existing imports keep working. The control plane does not depend on this package. Install it only in an application that compiles ZModel or hosts the model command transaction.

`@supacloud/db` catalog, RLS, and command-receipt code does not import this adapter.
