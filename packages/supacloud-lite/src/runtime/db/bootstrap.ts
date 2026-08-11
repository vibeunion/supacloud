/**
 * Idempotent bootstrap SQL that shapes a fresh database like a Supabase
 * project. Two variants: the full {@link BOOTSTRAP_SQL} for the real engines,
 * and the reduced {@link MINIMAL_BOOTSTRAP_SQL} below for the pg-mem subset.
 * Both are safe to re-run (create ... if not exists / create or replace).
 */

/**
 * Reduced bootstrap for subset engines (pg-mem) that can't run plpgsql, RLS
 * policies, extensions, or LISTEN/NOTIFY. Just the schemas, core tables, and
 * SQL-language auth helpers needed for the REST + auth CRUD surface. No RLS is
 * enforced here - this path is for local-dev/preview only.
 */
export const MINIMAL_BOOTSTRAP_SQL = `
create schema if not exists auth;
create schema if not exists storage;
create schema if not exists supabase_migrations;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  aud text default 'authenticated',
  role text default 'authenticated',
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_super_admin boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text unique,
  phone_confirmed_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean default false
);

create table if not exists auth.refresh_tokens (
  id bigserial primary key,
  token text unique not null,
  user_id uuid not null,
  parent text,
  session_id uuid,
  revoked boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auth.one_time_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  email text,
  phone text,
  token_type text not null,
  token text not null,
  attempts int not null default 0,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  constraint one_time_tokens_contact_check check (
    (email is not null and phone is null) or (email is null and phone is not null)
  )
);

-- Minimal engines can persist a database created by an older Lite version.
-- Standard ALTER statements keep that path compatible without requiring plpgsql.
alter table auth.one_time_tokens add column if not exists phone text;
alter table auth.one_time_tokens alter column email drop not null;
alter table auth.one_time_tokens drop constraint if exists one_time_tokens_contact_check;
alter table auth.one_time_tokens add constraint one_time_tokens_contact_check check (
  (email is not null and phone is null) or (email is null and phone is not null)
);

create unique index if not exists one_time_tokens_phone_type_idx
  on auth.one_time_tokens(phone, token_type) where phone is not null;

create table if not exists auth.phone_otp_cooldowns (
  phone_fingerprint text primary key,
  issuance_id uuid not null,
  last_sent_at timestamptz not null default now()
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  provider_id text not null,
  identity_data jsonb default '{}'::jsonb,
  last_sign_in_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, provider_id)
);

create table if not exists auth.flow_state (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_state text not null unique,
  redirect_to text,
  code_challenge text,
  code_challenge_method text,
  auth_code text unique,
  user_id uuid,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  friendly_name text,
  factor_type text not null default 'totp',
  status text not null default 'unverified',
  secret text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auth.mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  factor_id uuid not null,
  verified_at timestamptz,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists auth.audit_log_entries (
  id uuid primary key default gen_random_uuid(),
  payload jsonb,
  created_at timestamptz default now(),
  ip_address varchar(64) not null default ''
);

-- runtime-mutable instance settings (Studio auth toggles)
create table if not exists auth.config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  owner_id text,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table storage.buckets add column if not exists owner_id text;
update storage.buckets
set owner_id = owner::text
where owner_id is null and owner is not null;

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null,
  name text not null,
  owner uuid,
  owner_id text,
  version text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);

alter table storage.objects add column if not exists owner_id text;
update storage.objects
set owner_id = owner::text
where owner_id is null and owner is not null;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text,
  statements text[],
  applied_at timestamptz default now()
);

create table if not exists supabase_migrations.seed_files (
  path text primary key,
  hash text,
  applied_at timestamptz default now()
);
`

/**
 * Full bootstrap for the real engines (PGlite / native embedded Postgres):
 * extensions, the anon/authenticated/service_role roles, GoTrue-compatible auth
 * schema, storage schema with default RLS policies, migration bookkeeping, and
 * the realtime CDC + broadcast plumbing.
 */
export const BOOTSTRAP_SQL = `
-- ── Extensions ─────────────────────────────────────────────────────────────
-- Supabase enables these by default and migrations lean on them
-- (uuid_generate_v4(), crypt(), citext, pg_trgm, …). Each is created into the
-- 'extensions' schema like hosted Supabase; any not available in this engine
-- build is skipped rather than aborting the whole bootstrap.
create schema if not exists extensions;
do $$
declare ext text;
begin
  foreach ext in array array['uuid-ossp','pgcrypto','citext','pg_trgm','ltree','hstore','fuzzystrmatch'] loop
    begin
      execute format('create extension if not exists %I with schema extensions', ext);
    exception when others then
      -- extension not bundled in this engine build; continue
    end;
  end loop;
end $$;

-- uuid-ossp isn't in every Postgres build (it needs an external UUID lib at
-- build time - e.g. the theseus Linux binaries omit it). uuid_generate_v4() is
-- the single most-used function from it, so shim it onto core gen_random_uuid()
-- (also a v4 UUID) whenever the real extension isn't present, so migrations
-- that call it work identically on every engine and platform.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'uuid_generate_v4' and n.nspname in ('public', 'extensions')
  ) then
    create function extensions.uuid_generate_v4() returns uuid
      language sql volatile as 'select gen_random_uuid()';
  end if;
end $$;

-- Make extension functions resolvable unqualified (uuid_generate_v4(), …) on
-- the current session (migrations run here) and for future connections.
do $$
begin
  execute 'alter database ' || quote_ident(current_database()) ||
          ' set search_path to "$user", public, extensions';
exception when others then
  -- some engines disallow altering the current database; session SET below still applies
end $$;
set search_path to "$user", public, extensions;

-- ── Roles ────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema extensions to anon, authenticated, service_role;
alter role anon set search_path to "$user", public, extensions;
alter role authenticated set search_path to "$user", public, extensions;
alter role service_role set search_path to "$user", public, extensions;

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;

-- PostgreSQL already grants EXECUTE on new functions to PUBLIC. Keep that
-- default so project migrations can revoke PUBLIC and grant only selected
-- roles without hidden direct grants from Lite. Existing ACLs are left intact.

-- ── Auth schema (GoTrue-compatible subset) ───────────────────────────────
create schema if not exists auth;

create table if not exists auth.users (
  instance_id uuid default '00000000-0000-0000-0000-000000000000',
  id uuid primary key default gen_random_uuid(),
  aud text default 'authenticated',
  role text default 'authenticated',
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token text default '',
  confirmation_sent_at timestamptz,
  recovery_token text default '',
  recovery_sent_at timestamptz,
  email_change_token_new text default '',
  email_change text default '',
  email_change_sent_at timestamptz,
  email_change_token_current text default '',
  email_change_confirm_status smallint default 0,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_super_admin boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  phone text unique,
  phone_confirmed_at timestamptz,
  phone_change text default '',
  phone_change_token text default '',
  phone_change_sent_at timestamptz,
  reauthentication_token text default '',
  reauthentication_sent_at timestamptz,
  banned_until timestamptz,
  deleted_at timestamptz,
  is_anonymous boolean default false
);

create table if not exists auth.refresh_tokens (
  id bigint generated by default as identity primary key,
  token text unique not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent text,
  session_id uuid,
  revoked boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists refresh_tokens_user_id_idx on auth.refresh_tokens(user_id);

create table if not exists auth.one_time_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text,
  phone text,
  token_type text not null, -- otp | magiclink | recovery | sms
  token text not null,
  attempts int not null default 0,
  created_at timestamptz default now(),
  expires_at timestamptz not null,
  constraint one_time_tokens_contact_check check (
    (email is not null and phone is null) or (email is null and phone is not null)
  )
);

-- Upgrade databases created by Lite <=0.5.9 without touching existing email tokens.
alter table auth.one_time_tokens add column if not exists phone text;
alter table auth.one_time_tokens alter column email drop not null;
do $phone_otp_contact_constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'auth.one_time_tokens'::regclass
      and conname = 'one_time_tokens_contact_check'
  ) then
    alter table auth.one_time_tokens add constraint one_time_tokens_contact_check check (
      (email is not null and phone is null) or (email is null and phone is not null)
    );
  end if;
end $phone_otp_contact_constraint$;

create unique index if not exists one_time_tokens_phone_type_idx
  on auth.one_time_tokens(phone, token_type) where phone is not null;

-- Only a keyed phone fingerprint is persisted for cooldown enforcement; the
-- normalized phone number never enters this table.
create table if not exists auth.phone_otp_cooldowns (
  phone_fingerprint text primary key,
  issuance_id uuid not null,
  last_sent_at timestamptz not null default now()
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  provider_id text not null,
  identity_data jsonb default '{}'::jsonb,
  last_sign_in_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (provider, provider_id)
);

-- OAuth / PKCE flow state, bridging /authorize → provider → /callback → exchange
create table if not exists auth.flow_state (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_state text not null unique,
  redirect_to text,
  code_challenge text,
  code_challenge_method text,
  auth_code text unique,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create table if not exists auth.mfa_factors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  friendly_name text,
  factor_type text not null default 'totp',
  status text not null default 'unverified', -- unverified | verified
  secret text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists auth.mfa_challenges (
  id uuid primary key default gen_random_uuid(),
  factor_id uuid not null references auth.mfa_factors(id) on delete cascade,
  verified_at timestamptz,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

-- append-only security audit trail (GoTrue-compatible shape)
create table if not exists auth.audit_log_entries (
  instance_id uuid default '00000000-0000-0000-0000-000000000000',
  id uuid primary key default gen_random_uuid(),
  payload jsonb,
  created_at timestamptz default now(),
  ip_address varchar(64) not null default ''
);
create index if not exists audit_logs_instance_id_idx on auth.audit_log_entries(created_at);

-- runtime-mutable instance settings (Studio auth toggles)
create table if not exists auth.config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz default now()
);

grant usage on schema auth to anon, authenticated, service_role;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', 'anon')
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select auth.jwt() ->> 'email'
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;

-- ── Storage schema (storage-api-compatible subset) ───────────────────────
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  owner_id text,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table storage.buckets add column if not exists owner_id text;
update storage.buckets
set owner_id = owner::text
where owner_id is null and owner is not null;

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner uuid,
  owner_id text,
  version text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);

-- storage-api keeps the legacy UUID owner and the current text owner_id in
-- parallel. Re-running bootstrap upgrades existing Lite databases and retains
-- object ownership for rows created before owner_id support was added.
alter table storage.objects add column if not exists owner_id text;
update storage.objects
set owner_id = owner::text
where owner_id is null and owner is not null;

create index if not exists objects_bucket_name_idx on storage.objects(bucket_id, name);

grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to anon, authenticated, service_role;
grant all on storage.buckets to service_role;
grant all on storage.objects to anon, authenticated, service_role;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

create or replace function storage.filename(name text) returns text
language sql immutable as $$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
$$;

create or replace function storage.extension(name text) returns text
language sql immutable as $$
  select reverse(split_part(reverse(storage.filename(name)), '.', 1))
$$;

alter table storage.objects enable row level security;

drop policy if exists supacloud_lite_authenticated_all on storage.objects;
drop policy if exists supacloud_lite_public_read on storage.objects;

do $legacy_policy_cleanup$
declare
  legacy_prefix constant text := 'tin' || 'base';
begin
  execute format(
    'drop policy if exists %I on storage.objects',
    legacy_prefix || '_authenticated_all'
  );
  execute format(
    'drop policy if exists %I on storage.objects',
    legacy_prefix || '_public_read'
  );
end $legacy_policy_cleanup$;

-- ── Migration bookkeeping (same table the Supabase CLI uses) ─────────────
create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  name text,
  statements text[],
  applied_at timestamptz default now()
);

create table if not exists supabase_migrations.seed_files (
  path text primary key,
  hash text,
  applied_at timestamptz default now()
);

-- ── Realtime CDC plumbing ─────────────────────────────────────────────────
do $legacy_schema_upgrade$
declare
  legacy_schema constant text := 'tin' || 'base';
begin
  if exists (select 1 from pg_namespace where nspname = legacy_schema)
     and not exists (select 1 from pg_namespace where nspname = 'supacloud_lite') then
    execute format('alter schema %I rename to supacloud_lite', legacy_schema);
  end if;
end $legacy_schema_upgrade$;

create schema if not exists supacloud_lite;

create or replace function supacloud_lite.cdc_notify() returns trigger
language plpgsql security definer as $$
declare
  payload text;
begin
  payload := json_build_object(
    'schema', TG_TABLE_SCHEMA,
    'table', TG_TABLE_NAME,
    'type', TG_OP,
    'commit_timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'record', case when TG_OP in ('INSERT', 'UPDATE') then row_to_json(NEW) else null end,
    'old_record', case when TG_OP in ('UPDATE', 'DELETE') then row_to_json(OLD) else null end
  )::text;
  -- pg_notify payloads are capped at ~8kB; degrade like Supabase does.
  if octet_length(payload) > 7500 then
    payload := json_build_object(
      'schema', TG_TABLE_SCHEMA,
      'table', TG_TABLE_NAME,
      'type', TG_OP,
      'commit_timestamp', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'record', null,
      'old_record', null,
      'errors', json_build_array('Payload too large')
    )::text;
  end if;
  perform pg_notify('supacloud_lite_cdc', payload);
  return coalesce(NEW, OLD);
end $$;

do $legacy_trigger_upgrade$
declare
  legacy_schema constant text := 'tin' || 'base';
  legacy_trigger constant text := ('tin' || 'base') || '_cdc';
  trigger_record record;
  target_exists boolean;
begin
  for trigger_record in
    select c.oid as relation_oid, n.nspname as schema_name, c.relname as table_name
      from pg_trigger tg
      join pg_class c on c.oid = tg.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_proc p on p.oid = tg.tgfoid
      join pg_namespace pn on pn.oid = p.pronamespace
     where not tg.tgisinternal
       and tg.tgname = legacy_trigger
       and p.proname = 'cdc_notify'
       and pn.nspname in (legacy_schema, 'supacloud_lite')
  loop
    select exists (
      select 1
        from pg_trigger
       where not tgisinternal
         and tgrelid = trigger_record.relation_oid
         and tgname = 'supacloud_lite_cdc'
    ) into target_exists;

    execute format(
      'drop trigger %I on %I.%I',
      legacy_trigger,
      trigger_record.schema_name,
      trigger_record.table_name
    );

    if not target_exists then
      execute format(
        'create trigger supacloud_lite_cdc after insert or update or delete on %I.%I for each row execute function supacloud_lite.cdc_notify()',
        trigger_record.schema_name,
        trigger_record.table_name
      );
    end if;
  end loop;
end $legacy_trigger_upgrade$;

do $legacy_schema_cleanup$
declare
  legacy_schema constant text := 'tin' || 'base';
begin
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = legacy_schema
       and p.proname = 'cdc_notify'
       and p.pronargs = 0
  ) then
    execute format('drop function %I.cdc_notify()', legacy_schema);
  end if;

  if exists (select 1 from pg_namespace where nspname = legacy_schema) then
    begin
      execute format('drop schema %I', legacy_schema);
    exception when dependent_objects_still_exist then
      raise notice 'SupaCloud Lite: retained non-empty legacy runtime schema';
    end;
  end if;
end $legacy_schema_cleanup$;

-- ── Realtime Authorization + broadcast-from-database ──────────────────────
-- Mirrors Supabase Realtime: developers write RLS policies on
-- realtime.messages using realtime.topic(); a SELECT policy grants a private
-- channel's subscribers the right to *receive*, an INSERT policy the right to
-- *broadcast*. realtime.send() lets the database push a broadcast to a topic.
create schema if not exists realtime;

create table if not exists realtime.messages (
  id uuid not null default gen_random_uuid(),
  topic text not null,
  extension text not null,
  event text,
  payload jsonb,
  private boolean default false,
  inserted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id)
);
alter table realtime.messages enable row level security;

grant usage on schema realtime to anon, authenticated, service_role;
grant all on realtime.messages to anon, authenticated, service_role;

-- the topic currently being authorized/broadcast (set per operation)
create or replace function realtime.topic() returns text
  language sql stable as $$ select nullif(current_setting('realtime.topic', true), '') $$;

-- push a broadcast message to all subscribers of <topic> from SQL / triggers.
-- Delivered over the websocket by the in-process realtime engine, which listens
-- on the 'supacloud_lite_realtime_broadcast' channel.
create or replace function realtime.send(payload jsonb, event text, topic text, private boolean default true)
  returns void language plpgsql security definer as $$
begin
  perform pg_notify(
    'supacloud_lite_realtime_broadcast',
    json_build_object('topic', topic, 'event', event, 'payload', payload, 'private', private)::text
  );
exception when others then
  -- never let a notify failure abort the caller's transaction
  null;
end $$;

grant execute on function realtime.topic() to anon, authenticated, service_role;
grant execute on function realtime.send(jsonb, text, text, boolean) to anon, authenticated, service_role;
`
