# supacloud

Unified entrypoint that bundles both SupaCloud CLIs behind a single `supacloud` command.

```
supacloud cli   → @supacloud/cli    (project-scoped developer tools)
supacloud admin → @supacloud/admin  (platform operations: install / SSH / tenant management)
```

## 安装

```bash
npm install -g supacloud
supacloud --help
```

One-off execution:

```bash
npx supacloud cli status
npx supacloud admin status
```

`supacloud` depends on both `@supacloud/cli` and `@supacloud/admin`, so installing
it gives you the full toolset. You can still install either CLI on its own
(`@supacloud/cli` exposes `supacloud-cli`, `@supacloud/admin` exposes `supacloud-admin`).

## 用法

```bash
supacloud cli status
supacloud cli project get
supacloud cli gateway routes --ref <ref>

supacloud admin status
supacloud admin project list
supacloud admin ssh ping
```

Each subcommand accepts its own `--help`:

```bash
supacloud cli --help
supacloud admin --help
```

## 上下文

`supacloud cli` auto-links the current project from `.env`:

- `SUPABASE_URL` / `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` / `SUPACLOUD_API_TOKEN`

`supacloud admin` expects platform context:

- `SUPACLOUD_HOST` + `SUPACLOUD_SSH_KEY` / `SUPACLOUD_SSH_PASS`
- `SUPACLOUD_API_URL` + `SUPACLOUD_API_TOKEN`

> Note: on hosts where SupaCloud is installed as a server, `/usr/local/bin/supacloud`
> is the compiled management-api binary (the server process). This npm package's
> `supacloud` command targets developer/operator workflows and is meant for your
> local machine, not the server's process namespace.
