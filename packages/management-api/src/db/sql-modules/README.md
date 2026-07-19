# Canonical SQL modules

Files in this directory are the source of truth for reusable platform SQL.

- TypeScript migration/runtime code imports the modules through `src/db/sql-modules.ts`.
- Standalone SQL and compatibility scripts contain generated marker blocks.
- Run `bun run sql:sync` after editing a module.
- Run `bun run sql:check` to reject drift without changing files.
- Run `bun run test:sql-modules` to enforce 100% line, function, and statement coverage for the synchronizer and module loaders.

Do not edit content between `supacloud:sql-module:*` markers directly.
