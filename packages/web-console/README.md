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

## Tech Stack

- [SvelteKit](https://kit.svelte.dev/) - Full-stack web framework
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
