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

## 更新检查

Normal `supacloudctl cli ...` and `supacloudctl admin ...` dispatch is local-only and does not
contact npm. Run an explicit check when needed:

```bash
supacloudctl check-update
supacloudctl check-update cli
supacloudctl check-update admin
```

The dispatcher never downloads or executes a newer operator CLI implicitly. To opt into the old
notify-before-dispatch behavior, set:

```bash
SUPACLOUD_AUTO_UPDATE=1 supacloudctl cli status
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
- `SUPACLOUD_PROJECT_REF` when it cannot be inferred from a managed `<ref>.api.*` hostname

`supacloudctl admin` expects platform context:

- `SUPACLOUD_HOST` + `SUPACLOUD_SSH_KEY` / `SUPACLOUD_SSH_PASS` + `SUPACLOUD_SSH_HOST_FINGERPRINT`
- `SUPACLOUD_API_URL` + `SUPACLOUD_API_TOKEN`

> Note: `/usr/local/bin/supacloud` is the compiled management-api server binary.
> This npm package exposes only `supacloudctl`; it does not install a `supacloud`
> compatibility alias and should normally be used on an operator's local machine.
