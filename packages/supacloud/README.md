# supacloud

Unified entrypoint that bundles both SupaCloud CLIs behind a single `supacloudctl` command.

```
supacloudctl cli   → @supacloud/cli    (project-scoped developer tools)
supacloudctl admin → @supacloud/admin  (platform operations: install / SSH / tenant management)
```

## 安装

```bash
npm install -g supacloud
supacloudctl --help
```

One-off execution:

```bash
npx --package supacloud supacloudctl cli status
npx --package supacloud supacloudctl admin status
```

`supacloud` depends on both `@supacloud/cli` and `@supacloud/admin`, so installing
it gives you the full toolset. You can still install either CLI on its own
(`@supacloud/cli` exposes `supacloud-cli`, `@supacloud/admin` exposes `supacloud-admin`).

## 更新提示

`supacloudctl cli ...` and `supacloudctl admin ...` check the npm `latest` dist-tag before dispatch.
When a newer package exists, the dispatcher prints an update notice but still runs the dependency
version bundled with the installed `supacloud` package. It never downloads or executes a newer
operator CLI implicitly.

Disable the latest check when you need a pinned local version:

```bash
SUPACLOUD_NO_AUTO_UPDATE=1 supacloudctl cli status
# or
SUPACLOUD_AUTO_UPDATE=0 supacloudctl admin status
```

Use `SUPACLOUD_NPM_REGISTRY` or `npm_config_registry` to point the check at a registry mirror.

## 用法

```bash
supacloudctl cli status
supacloudctl cli project get
supacloudctl cli gateway routes --ref <ref>

supacloudctl admin status
supacloudctl admin project list
supacloudctl admin ssh ping
```

Each subcommand accepts its own `--help`:

```bash
supacloudctl cli --help
supacloudctl admin --help
```

## 上下文

`supacloudctl cli` auto-links the current project from `.env`:

- `SUPABASE_URL` / `SUPACLOUD_API_URL`
- `SUPABASE_SERVICE_ROLE_KEY` / `SUPACLOUD_API_TOKEN`

`supacloudctl admin` expects platform context:

- `SUPACLOUD_HOST` + `SUPACLOUD_SSH_KEY` / `SUPACLOUD_SSH_PASS`
- `SUPACLOUD_API_URL` + `SUPACLOUD_API_TOKEN`

> Note: `/usr/local/bin/supacloud` is the compiled management-api server binary.
> This npm package exposes only `supacloudctl`; it does not install a `supacloud`
> compatibility alias and should normally be used on an operator's local machine.
