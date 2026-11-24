# GoTrue v2.198.0 adoption review

Reviewed on 2026-11-24 against the official [supabase/auth](https://github.com/supabase/auth) Releases API, git tags, and the `supabase/gotrue` Docker Hub repository.

SupaCloud stays on the stock GoTrue release **v2.198.0**. That tag is the newest stable official release. The only newer published artifact is the pre-release `v2.199.0-rc.5`. It is not a stable release, and this repository does not adopt it.

This review does not upgrade a host, retag an image, publish npm, or change the FA deployment root. The FA deployment root is outside this git tree. Merging this record is not a production deploy.

## Why v2.198.0 is the target

| Candidate | Kind | Decision |
| --- | --- | --- |
| [v2.198.0](https://github.com/supabase/auth/releases/tag/v2.198.0) | Stable release, published 2026-11-16, `prerelease=false`, commit `387e91f37e00b64b9060352988066bbb685f6e45` | Keep. Already pinned across installers, Compose, Podman, and CI. |
| [v2.199.0-rc.5](https://github.com/supabase/auth/releases/tag/rc2.199.0-rc.5) | Pre-release, published 2026-11-17. The git tag is `rc2.199.0-rc.5`. The release notes say it is a release candidate for [release-please PR #2938](https://github.com/supabase/auth/pull/2938). | Do not adopt. |
| `v2.199.0` | Not published. No git tag, no GitHub Release, and no `supabase/gotrue:v2.199.0` Docker tag on 2026-11-24. | Nothing to pin. |

`v2.199.0-rc.5` is five commits ahead of v2.198.0. All five commits add experimental `private_key_jwt` client assertions for custom OAuth providers ([#2932](https://github.com/supabase/auth/pull/2932) through [#2936](https://github.com/supabase/auth/pull/2936)). They also add the embedded migration `20261116120000_add_client_auth_method_to_custom_oauth_providers.up.sql`, which adds:

- `custom_oauth_providers.client_auth_method text not null default 'client_secret'`
- `custom_oauth_providers.client_assertion_audience text null`

GoTrue applies embedded migrations when it starts. Starting the release candidate would write that column before upstream cuts a stable `v2.199.0`. A later binary rollback would not drop the column. Docker Hub has `supabase/gotrue:v2.199.0-rc.5` and does not have `supabase/gotrue:v2.199.0`. The release-please pull request was still open on 2026-11-24.

There is no newer stable release that fixes a vulnerability absent from v2.198.0. v2.198.0 already includes the Go 1.27.4 net/http fix and the OAuth client token restriction described below.

## Pins that stay on v2.198.0

| Surface | Reference |
| --- | --- |
| Binary default | `SUPACLOUD_GOTRUE_DEFAULT_VERSION` in `scripts/lib/gotrue_upgrade.sh` |
| Tenant start check | `GOTRUE_DEFAULT_VERSION` in `scripts/lib/tenant_runtime.sh` |
| Development Compose | `supabase/gotrue:v2.198.0` in `docker/dev/docker-compose.yml` |
| Self-host Compose | `supabase/gotrue:v2.198.0` in `docker/self-host/docker-compose.yml` |
| Podman Quadlet | `docker.io/supabase/gotrue:v2.198.0` in `podman/self-host/quadlet/supacloud-gotrue.container` |
| Management API CI | `supabase/gotrue:v2.198.0` in `.github/workflows/management-api.yml` |

The installer downloads `auth-<version>-<arch>.tar.xz` from `https://github.com/supabase/auth/releases/download/<version>/`. It does not build GoTrue from source. There is no Helm chart and no Go module pin for this server in this repository.

Release assets checked on 2026-11-24 by downloading the official files and computing SHA256:

| Asset | SHA256 |
| --- | --- |
| `auth-v2.198.0-amd64.tar.xz` | `4abe9134d7615faa9149cab514acada8e7133cd69d2ccd96fdcef0d795c05171` |
| `auth-v2.198.0-arm64.tar.xz` | `bfc0032688df320be7c6e7bfd00b319ba757eca41763ea012095948929441c34` |

Both digests match `scripts/lib/gotrue_upgrade.sh` and the checksums published on the v2.198.0 release. Docker Hub tag `v2.198.0` was updated 2026-11-16.

## Migrations already inside v2.198.0

GoTrue runs its embedded migrations on startup. SupaCloud does not add a second migration for these files, and `supabase_auth_admin` keeps the rights GoTrue needs to apply them. The v2.198.0 tree contains 77 `*.up.sql` migrations. The two added after v2.197.0 are:

- `20260911120000_add_link_token_hash_to_one_time_tokens.up.sql` adds nullable `one_time_tokens.link_token_hash` and a hash index, with a btree index if hash index creation fails.
- `20261030120000_add_dedicated_scope_to_saml_providers.up.sql` adds nullable `saml_providers.dedicated_scope`.

Earlier additive migrations from v2.192.0 through v2.197.0 remain in that tree. The historical v2.191.0-to-v2.193.0 baseline is in [gotrue-v2.193-upgrade.md](./gotrue-v2.193-upgrade.md).

On a host that is not yet running v2.198.0, back up each tenant `auth` schema before the first start of this binary or image. Restoring an older binary does not undo those columns and does not guarantee that an OTP issued by the newer binary still verifies.

## Behavior this pin already has, and what stays unchanged

v2.198.0 configuration, read from `internal/conf/configuration.go` at tag `v2.198.0`:

- `GOTRUE_EXPERIMENTAL_ENABLE_OTT_AS_SOURCE_OF_TRUTH` defaults to `false`. When left off, typed OTP verification still reads the `users` token columns. SupaCloud does not set this variable. The Chinese summary in [platform-component-upgrade-notes.md](./platform-component-upgrade-notes.md) compresses the v2.198 OTP work into an automatic source-of-truth move. That flag is experimental and stays off in this repository.
- `GOTRUE_EXPERIMENTAL_ONE_TIME_TOKEN_EXPIRES_AT_WRITE_ENABLED` also defaults to `false`. SupaCloud does not set it.
- Send SMS Hook remains `GOTRUE_HOOK_SEND_SMS_ENABLED`, `GOTRUE_HOOK_SEND_SMS_URI`, and `GOTRUE_HOOK_SEND_SMS_SECRETS`. The Management API adapter and the Tencent Cloud SMS path are unchanged.
- OAuth client access tokens may still call `GET /user` and `GET /oauth/userinfo`. They receive `403 no_authorization` for user mutation, MFA, passkeys, logout, reauthenticate, and admin routes. Ordinary user session tokens are not under that restriction. This is existing v2.198.0 behavior, already documented by upstream, and this review does not change it.
- Session, password, passkey, SAML, database-encryption, and provider-linking environment names used by `tenant-runtime.service.ts`, `tenant-runtime-config.ts`, and `auth-session-policy.ts` are still present. The refresh-token reuse variable remains `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL`.

Role and isolation boundaries stay as they are:

- Do not rename the cluster-wide `LOGIN` roles `supabase_auth_admin` or `supabase_admin`.
- Do not rewrite Pigsty-owned `pg_hba.conf`.
- Isolation remains one database per project.
- Cluster-wide `NOLOGIN` for `anon`, `authenticated`, and `service_role` stays in place.

## When v2.199.0 becomes a stable release

Wait for a non-prerelease git tag `v2.199.0`, a matching `supabase/gotrue:v2.199.0` image, and published `auth-v2.199.0-amd64.tar.xz` / `auth-v2.199.0-arm64.tar.xz` checksums. Then pin those three surfaces together. Before the first start, back up `auth` and read the `client_auth_method` migration. Do not point production at `v2.199.0-rc.5` in the meantime.
