# SupaCloud Web Console

Modern management dashboard for SupaCloud, built with **SvelteKit** + **TailwindCSS**.

## Features

- 🔐 **Login Authentication**: Secure login with session management
- 📊 **Project Dashboard**: View and manage all Supabase projects with cached Management API summary data
- ⚙️ **Project Settings**: Configure project settings, API keys, auth providers
- 📈 **System Monitoring**: Real-time system health and resource monitoring
- 🚀 **One-click Operations**: Create, pause, restore, restart projects
- 🎨 **Modern UI**: Responsive dark-mode SvelteKit interface

## Development

```bash
cd packages/web-console
bun install
bun run dev
```

The dev server will start at `http://localhost:5173`.

## Building

```bash
bun run build
```

The production build outputs to `build/` directory. In production, the Management API serves these assets as embedded SPA.

## SVAdmin Styles

The console uses `@svadmin/ui@0.69.0`, `@svadmin/core@0.49.1`,
`@svadmin/ai-elements@0.4.1`, and `@svadmin/sveltekit@0.10.6`.
`@svadmin/elysia` stays on npm's published `0.11.0`; a newer GitHub release
alone is not an installable dependency.

Tailwind v4 configuration lives in `src/app.css`. Import
`@svadmin/ui/app.theme.css` once after Tailwind, not alongside
`@svadmin/ui/app.css`. This entry includes precompiled component styles and
semantic theme metadata, so the host does not scan UI package sources.
AI elements retain their separate stylesheet and source scan.

Use public component entries such as
`@svadmin/ui/components/AutoTable.svelte`. The root UI entry re-exports
`AdminApp`, which imports the default stylesheet as a side effect in development.
The hybrid layout does not use `AdminApp`; importing individual components
avoids a second stylesheet overriding the host palette.

Theme overrides use complete CSS colors such as `--background: hsl(0 0% 100%)`,
not bare HSL channels. The UI stylesheet provides the `--color-*` aliases;
the console preserves its existing light/dark palette and class-based dark mode.

Migration acceptance:

```gherkin
Scenario: Existing provider behavior
  Given the upgraded console uses the existing authenticated providers
  When users load project resources or stream an assistant response
  Then the resource envelopes, tenant scope, and streaming behavior remain unchanged

Scenario: Table list identity
  Given the table-list API returns public-schema table names without an id field
  When the list contains multiple tables
  Then each row uses table_name as its identity without duplicate-key errors

Scenario: Persistent column visibility
  Given a table contains an Email column
  When the user hides the column and remounts the table
  Then the column stays hidden in desktop and mobile views and can be restored

Scenario: Precompiled component styles
  Given the host does not scan SVAdmin UI sources
  When the console stylesheet is compiled
  Then the table utility aliases and semantic component styles are included

Scenario: Theme compatibility
  Given the console uses complete semantic color values
  When the user switches between light and dark mode
  Then both host utilities and SVAdmin components use valid colors
```

Run `bun test`, `bun run check`, and `bun run build` from this package.
Browser checks with mocked API responses verify rendering only, not live backend
authorization or deployment acceptance.

## Tech Stack

- [SvelteKit](https://kit.svelte.dev/) - SPA application framework used with `adapter-static`
- [TailwindCSS](https://tailwindcss.com/) - Utility-first CSS
- [TypeScript](https://www.typescriptlang.org/) - Type-safe JavaScript

## Architecture Note

The console is compiled as a pure SPA (Single Page Application) using SvelteKit's `adapter-static`.
To ensure compatibility:
- **Do not use `+page.server.ts` or `+layout.server.ts`** files, as they rely on Node.js at runtime and break static exports.

### SVAdmin Hybrid Mount Architecture

SupaCloud's Web Console now uses a custom hybrid architecture with the **SVAdmin** framework:
- **Global Data Flow**: We use `@tanstack/svelte-query` and SVAdmin's `DataProvider` injected at the layout level (`+layout.svelte`) to automatically append authentication headers and handle caching.
- **Dynamic Tenant Resources**: Resources (like `v1/projects/[ref]/database/tables` and `auth/users`) are dynamically registered via a `$effect` hook based on SvelteKit routing parameters, meaning SVAdmin adapts seamlessly to whichever tenant project you are viewing.
- **Dashboard Summary Hot Path**: Project dashboards first call `/v1/projects/:ref/dashboard/summary`; legacy per-card SQL calls remain as fallback if the summary endpoint is unavailable.
- **Auto Components & Headless Hooks**: 
  - Standard CRUD pages (like Auth Users or Tables) use declarative `<AutoTable />` with custom Svelte snippets (`#snippet cellRenderer`) to preserve Supabase-like visual styling without manual markup.
  - Complex custom pages (like Storage buckets or Edge Function deployments) use SVAdmin's headless hooks (`useList`, `useDelete`) coupled with fully custom Svelte layouts (like split-panes or Monaco editors).
