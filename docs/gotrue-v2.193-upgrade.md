# GoTrue v2.193.0 Upgrade

SupaCloud pins the stock [`supabase/auth` v2.193.0 release](https://github.com/supabase/auth/releases/tag/v2.193.0). The release assets accepted by the installer are:

| Architecture | Asset SHA256 |
| --- | --- |
| `linux-amd64` | `c991b6fb8747bbcbcef40701177234f152cea28a108a481bae917bacc1a522c5` |
| `linux-arm64` | `432fa68ef58afac8665d45537d8adbba5756b01829f175ed7ef6314b3ca59995` |

Do not replace either checksum without verifying the official release asset independently.

## Pre-upgrade backup

Back up the tenant `auth` schema before changing the GoTrue image or binary. Keep the project configuration, generated GoTrue environment file, and secret inventory with the database backup so the previous runtime can be restored without reconstructing configuration from memory.

For PostgreSQL, use an operator-approved destination with restricted permissions:

```bash
pg_dump --schema=auth --format=custom --file=backups/auth-before-gotrue-v2.193.dump "$DATABASE_URL"
```

Never print `DATABASE_URL`, JWT signing material, provider secrets, or the backup contents in CI logs.

## Migration sequence and read-back

The v2.191.0-to-v2.192.0 upgrade contains the additive upstream migration `20260625000000_add_custom_claims_allowlist.up.sql`. After starting v2.192.0 or later, verify the resulting column instead of marking the migration complete from process health alone:

```sql
SELECT data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'auth'
  AND table_name = 'custom_oauth_providers'
  AND column_name = 'custom_claims_allowlist';
```

The expected column is `text[] NOT NULL DEFAULT '{}'`. The upstream v2.192.0-to-v2.193.0 comparison contains no new migration file. Do not create a SupaCloud or application migration solely for v2.193.0.

## Provider-linking opt-in

Provider linking-domain groups remain disabled by default. Configure the project auth map at `experimental.provider_linking_domains`, for example `{ "custom:github": "social", "custom:google": "social" }`. SupaCloud validates and sorts the map before rendering `GOTRUE_EXPERIMENTAL_PROVIDER_LINKING_DOMAINS`; an absent or empty map emits no runtime variable.

The deprecated `experimental.providers_with_own_linking_domain` list is accepted only as migration input and is normalized to the new map. SupaCloud never writes the deprecated GoTrue environment variable.

After rendering the tenant runtime, inspect the generated environment without printing unrelated secrets. Confirm that neither variable is present by default and that an explicit mapping is preserved exactly.

## MFA acceptance

Run the compatibility suite against an unmodified v2.193.0 runtime. The MFA case must:

1. Enroll, challenge, and verify a TOTP factor through GoTrue.
2. Confirm the session reaches `aal2` and AMR records authentication methods.
3. Delete the verified factor through the GoTrue admin API.
4. Refresh the same session and confirm it downgrades to `aal1`.
5. Confirm the refreshed AMR no longer contains `totp` and uses `method`, not `factor_type`.

Also run the full password, session, refresh, OAuth PKCE, UserInfo, JWT/RLS, Storage, Realtime, and Functions compatibility matrix. A non-strict run or a skipped fixture is not upgrade evidence.

## Rollback boundary

Rollback restores the v2.192.0 GoTrue binary or image and the previous generated runtime manifest. The v2.192.0 `custom_claims_allowlist` column is additive and remains in place; do not drop it during application rollback. Restore the `auth` schema backup only for an actual data or schema recovery incident, after stopping writers and following the database recovery procedure.

Provider-linking variables can be removed independently before or after the binary rollback because they are opt-in. Re-run session refresh, OAuth PKCE, TOTP, and dependent Supabase service smoke tests after rollback.
