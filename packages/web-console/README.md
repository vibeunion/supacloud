# SupaCloud Web Console

Modern management dashboard for SupaCloud, built with **SvelteKit** + **TailwindCSS**.

## Features

- 🔐 **Login Authentication**: Secure login with session management
- 📊 **Project Dashboard**: View and manage all Supabase projects
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
- All data fetching should happen client-side in `+page.svelte` or `+page.ts` using the `apiClient`.
- Authentication routing uses `window.location.href` for hard redirects to overcome SPA routing state staleness during session expiration.
