/**
 * Pure-SQL emulations of Supabase's queue and cron extensions, so migrations
 * and app code that call pgmq.* / cron.* work with no C extension on either
 * engine. pgmq is fully self-contained SQL. cron records jobs here; the
 * in-process CronService (src/cron/service.ts) executes them.
 *
 * These match the real extensions' function signatures closely enough that
 * `pgmq.send(...)`, `pgmq.read(...)`, `select cron.schedule(...)` etc. behave
 * the same from the client's and a migration's point of view.
 */

// ── pgmq (message queue) ────────────────────────────────────────────────────

/**
 * Self-contained SQL emulation of the pgmq extension: per-queue `q_<name>` /
 * `a_<name>` tables plus create/send/read/pop/delete/archive/etc functions,
 * matching pgmq's signatures. No C extension, no background worker needed.
 */
export const PGMQ_SQL = `
create schema if not exists pgmq;
revoke all on schema pgmq from public, anon, authenticated;
grant usage on schema pgmq to service_role;

create table if not exists pgmq.meta (
  queue_name text primary key,
  physical_name text not null unique,
  is_partitioned boolean not null default false,
  is_unlogged boolean not null default false,
  created_at timestamptz not null default now()
);

-- Preserve queues created by older Lite versions. Their physical names were
-- the queue names, so only the already-truncated identifier can be recovered.
insert into pgmq.meta (queue_name, physical_name)
select substring(tablename from 3), substring(tablename from 3)
from pg_tables
where schemaname = 'pgmq' and left(tablename, 2) = 'q_'
on conflict do nothing;

do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where t.typname = 'message_record' and n.nspname = 'pgmq') then
    create type pgmq.message_record as (
      msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb
    );
  end if;
end $$;

create or replace function pgmq._normalize_queue_name(queue_name text)
returns text language plpgsql immutable set search_path = pgmq, pg_catalog, public as $pgmq$
declare normalized text := btrim(queue_name);
begin
  if normalized is null or normalized !~ '^[a-z0-9][a-z0-9_-]{0,127}$' then
    raise exception 'invalid queue name: must match ^[a-z0-9][a-z0-9_-]{0,127}$'
      using errcode = '22023';
  end if;
  return normalized;
end $pgmq$;

-- PostgreSQL identifiers are limited to 63 bytes. Keep the conventional table
-- name for short queues and add a deterministic hash for valid 62-128 byte
-- public names so truncation can never merge two queues.
create or replace function pgmq._physical_queue_name(queue_name text)
returns text language sql immutable set search_path = pgmq, pg_catalog, public as $pgmq$
  select case when length(normalized) <= 61 then normalized
    else left(normalized, 28) || '_' || md5(normalized) end
  from (select pgmq._normalize_queue_name(queue_name) as normalized) names;
$pgmq$;

create or replace function pgmq._resolve_queue(queue_name text)
returns text language plpgsql stable security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare normalized text := pgmq._normalize_queue_name(queue_name); physical text;
begin
  select physical_name into physical from pgmq.meta where pgmq.meta.queue_name = normalized;
  if physical is null then
    raise exception 'queue "%" does not exist', normalized using errcode = '42P01';
  end if;
  return physical;
end $pgmq$;

create or replace function pgmq.create(queue_name text) returns void language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare normalized text := pgmq._normalize_queue_name(queue_name); physical text := pgmq._physical_queue_name(queue_name);
begin
  insert into pgmq.meta (queue_name, physical_name) values (normalized, physical)
  on conflict do nothing;
  select physical_name into physical from pgmq.meta where pgmq.meta.queue_name = normalized;
  execute format('create table if not exists pgmq.%I (
    msg_id bigint generated always as identity primary key,
    read_ct integer not null default 0,
    enqueued_at timestamptz not null default now(),
    vt timestamptz not null default now(),
    message jsonb)', 'q_' || physical);
  execute format('create table if not exists pgmq.%I (
    msg_id bigint primary key, read_ct integer not null default 0,
    enqueued_at timestamptz not null, archived_at timestamptz not null default now(),
    vt timestamptz, message jsonb)', 'a_' || physical);
end $pgmq$;

create or replace function pgmq.send(queue_name text, msg jsonb, delay integer default 0)
returns bigint language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare id bigint; physical text := pgmq._resolve_queue(queue_name);
begin
  execute format('insert into pgmq.%I (vt, message) values (now() + make_interval(secs => $1), $2) returning msg_id', 'q_' || physical)
    into id using delay, msg;
  return id;
end $pgmq$;

create or replace function pgmq.send_batch(queue_name text, msgs jsonb[], delay integer default 0)
returns setof bigint language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare queue_message jsonb;
begin
  perform pgmq._resolve_queue(queue_name);
  foreach queue_message in array msgs loop
    return next pgmq.send(queue_name, queue_message, delay);
  end loop;
end $pgmq$;

create or replace function pgmq.read(queue_name text, vt integer, qty integer)
returns setof pgmq.message_record language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare physical text := pgmq._resolve_queue(queue_name);
begin
  return query execute format($fmt$
    with cte as (
      select msg_id from pgmq.%I where vt <= now() order by msg_id limit $1 for update skip locked
    )
    update pgmq.%I m set vt = now() + make_interval(secs => $2), read_ct = read_ct + 1
    from cte where m.msg_id = cte.msg_id
    returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  $fmt$, 'q_' || physical, 'q_' || physical) using qty, vt;
end $pgmq$;

create or replace function pgmq.pop(queue_name text)
returns setof pgmq.message_record language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare physical text := pgmq._resolve_queue(queue_name);
begin
  return query execute format($fmt$
    with cte as (select msg_id from pgmq.%I where vt <= now() order by msg_id limit 1 for update skip locked)
    delete from pgmq.%I m using cte where m.msg_id = cte.msg_id
    returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  $fmt$, 'q_' || physical, 'q_' || physical);
end $pgmq$;

create or replace function pgmq.set_vt(queue_name text, msg_id bigint, vt_offset integer)
returns setof pgmq.message_record language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare physical text := pgmq._resolve_queue(queue_name);
begin
  return query execute format($fmt$
    update pgmq.%I m set vt = now() + make_interval(secs => $1)
    where m.msg_id = $2
    returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
  $fmt$, 'q_' || physical) using vt_offset, msg_id;
end $pgmq$;

create or replace function pgmq.delete(queue_name text, msg_id bigint)
returns boolean language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare n integer; physical text := pgmq._resolve_queue(queue_name);
begin
  execute format('delete from pgmq.%I where msg_id = $1', 'q_' || physical) using msg_id;
  get diagnostics n = row_count;
  return n > 0;
end $pgmq$;

create or replace function pgmq.archive(queue_name text, msg_id bigint)
returns boolean language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare n integer; physical text := pgmq._resolve_queue(queue_name);
begin
  execute format($fmt$
    with del as (delete from pgmq.%I where msg_id = $1 returning *)
    insert into pgmq.%I (msg_id, read_ct, enqueued_at, vt, message)
    select msg_id, read_ct, enqueued_at, vt, message from del
  $fmt$, 'q_' || physical, 'a_' || physical) using msg_id;
  get diagnostics n = row_count;
  return n > 0;
end $pgmq$;

create or replace function pgmq.drop_queue(queue_name text) returns boolean language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare normalized text := pgmq._normalize_queue_name(queue_name); physical text;
begin
  select physical_name into physical from pgmq.meta where pgmq.meta.queue_name = normalized;
  if physical is null then return false; end if;
  execute format('drop table if exists pgmq.%I', 'q_' || physical);
  execute format('drop table if exists pgmq.%I', 'a_' || physical);
  delete from pgmq.meta where pgmq.meta.queue_name = normalized;
  return true;
end $pgmq$;

create or replace function pgmq.purge_queue(queue_name text) returns bigint language plpgsql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
declare n bigint; physical text := pgmq._resolve_queue(queue_name);
begin
  execute format('delete from pgmq.%I', 'q_' || physical);
  get diagnostics n = row_count;
  return n;
end $pgmq$;

create or replace function pgmq.list_queues()
returns table(queue_name text, is_partitioned boolean, is_unlogged boolean, created_at timestamptz)
language sql security definer set search_path = pgmq, pg_catalog, public as $pgmq$
  select queue_name, is_partitioned, is_unlogged, created_at from pgmq.meta;
$pgmq$;

revoke all on all functions in schema pgmq from public, anon, authenticated;
grant execute on all functions in schema pgmq to service_role;

create schema if not exists pgmq_public;
grant usage on schema pgmq_public to anon, authenticated, service_role;

create or replace function pgmq_public.send(queue_name text, message jsonb, sleep_seconds integer default 0)
returns setof bigint language sql volatile security definer set search_path = pgmq, pg_catalog, public as $pgmq_public$
  select * from pgmq.send(queue_name, message, sleep_seconds);
$pgmq_public$;

create or replace function pgmq_public.send_batch(queue_name text, messages jsonb[], sleep_seconds integer default 0)
returns setof bigint language sql volatile security definer set search_path = pgmq, pg_catalog, public as $pgmq_public$
  select * from pgmq.send_batch(queue_name, messages, sleep_seconds);
$pgmq_public$;

create or replace function pgmq_public.read(queue_name text, sleep_seconds integer, n integer)
returns setof pgmq.message_record language sql volatile security definer set search_path = pgmq, pg_catalog, public as $pgmq_public$
  select * from pgmq.read(queue_name, sleep_seconds, n);
$pgmq_public$;

create or replace function pgmq_public.pop(queue_name text)
returns setof pgmq.message_record language sql volatile security definer set search_path = pgmq, pg_catalog, public as $pgmq_public$
  select * from pgmq.pop(queue_name);
$pgmq_public$;

create or replace function pgmq_public.archive(queue_name text, message_id bigint)
returns boolean language sql volatile security definer set search_path = pgmq, pg_catalog, public as $pgmq_public$
  select pgmq.archive(queue_name, message_id);
$pgmq_public$;

create or replace function pgmq_public."delete"(queue_name text, message_id bigint)
returns boolean language sql volatile security definer set search_path = pgmq, pg_catalog, public as $pgmq_public$
  select pgmq.delete(queue_name, message_id);
$pgmq_public$;

revoke all on all functions in schema pgmq_public from public;
grant execute on all functions in schema pgmq_public to anon, authenticated, service_role;
`

// ── cron (scheduled jobs) ────────────────────────────────────────────────────

/**
 * pg_cron emulation: the `cron.job` / `cron.job_run_details` tables and
 * schedule/unschedule functions. This only records jobs; the in-process
 * CronService (src/cron/service.ts) reads the table and runs them.
 */
export const CRON_SQL = `
create schema if not exists cron;
-- cron.schedule executes arbitrary SQL as the (superuser) function owner, so it
-- must stay restricted to service_role - matching hosted Supabase, where
-- authenticated cannot schedule jobs.
grant usage on schema cron to service_role;

create table if not exists cron.job (
  jobid bigint generated always as identity primary key,
  schedule text not null,
  command text not null,
  jobname text unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists cron.job_run_details (
  runid bigint generated always as identity primary key,
  jobid bigint,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint language plpgsql security definer set search_path = cron, pg_catalog, public as $cron$
declare id bigint;
begin
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command, active = true
  returning jobid into id;
  return id;
end $cron$;

create or replace function cron.schedule(schedule text, command text)
returns bigint language plpgsql security definer set search_path = cron, pg_catalog, public as $cron$
begin
  return cron.schedule('job_' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint::text, schedule, command);
end $cron$;

create or replace function cron.unschedule(job_name text)
returns boolean language plpgsql security definer set search_path = cron, pg_catalog, public as $cron$
declare n integer;
begin
  delete from cron.job where jobname = job_name;
  get diagnostics n = row_count;
  return n > 0;
end $cron$;

create or replace function cron.unschedule(job_id bigint)
returns boolean language plpgsql security definer set search_path = cron, pg_catalog, public as $cron$
declare n integer;
begin
  delete from cron.job where jobid = job_id;
  get diagnostics n = row_count;
  return n > 0;
end $cron$;

grant execute on function cron.schedule(text,text,text), cron.schedule(text,text), cron.unschedule(text), cron.unschedule(bigint) to service_role;
`

/**
 * pg_net emulation - the `net.http_get/post/delete` SQL surface. The functions
 * only enqueue into net.http_request_queue; the in-process NetService
 * (src/net/service.ts) performs the HTTP and records the reply in
 * net._http_response, exactly like pg_net's background worker. This lets the
 * common Supabase pattern - a cron job that calls net.http_post to hit an Edge
 * Function - run unchanged, with no C extension on either engine.
 */
export const NET_SQL = `
create schema if not exists net;
-- net.http_* can reach arbitrary URLs from the server (SSRF surface), so keep it
-- restricted to service_role like hosted Supabase - not authenticated.
grant usage on schema net to service_role;

create table if not exists net.http_request_queue (
  id bigint generated always as identity primary key,
  method text not null,
  url text not null,
  headers jsonb not null default '{}'::jsonb,
  body text,
  timeout_milliseconds int not null default 5000,
  created timestamptz not null default now()
);

create table if not exists net._http_response (
  id bigint primary key,
  status_code int,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz not null default now()
);
grant select on net._http_response to service_role;

-- fold a jsonb param object into the URL as a query string (pg_net semantics)
create or replace function net._merge_params(url text, params jsonb)
returns text language sql immutable as $net$
  select case
    when params is null or params = '{}'::jsonb then url
    else url || (case when position('?' in url) > 0 then '&' else '?' end) ||
      (select string_agg(key || '=' || (value #>> '{}'), '&') from jsonb_each(params))
  end;
$net$;

create or replace function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language plpgsql security definer set search_path = net, pg_catalog, public as $net$
declare req_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('GET', net._merge_params(url, params), coalesce(headers, '{}'::jsonb), null, timeout_milliseconds)
  returning id into req_id;
  return req_id;
end $net$;

create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language plpgsql security definer set search_path = net, pg_catalog, public as $net$
declare req_id bigint; hdrs jsonb;
begin
  hdrs := coalesce(headers, '{}'::jsonb);
  -- default the content type to JSON, matching pg_net, unless the caller set one
  if not (hdrs ? 'Content-Type' or hdrs ? 'content-type') then
    hdrs := hdrs || jsonb_build_object('Content-Type', 'application/json');
  end if;
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', net._merge_params(url, params), hdrs, body::text, timeout_milliseconds)
  returning id into req_id;
  return req_id;
end $net$;

create or replace function net.http_delete(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds int default 5000)
returns bigint language plpgsql security definer set search_path = net, pg_catalog, public as $net$
declare req_id bigint;
begin
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('DELETE', net._merge_params(url, params), coalesce(headers, '{}'::jsonb), null, timeout_milliseconds)
  returning id into req_id;
  return req_id;
end $net$;

grant execute on function net.http_get(text,jsonb,jsonb,int), net.http_post(text,jsonb,jsonb,jsonb,int), net.http_delete(text,jsonb,jsonb,int) to service_role;
`

/**
 * Small pure-SQL stand-ins for contrib extensions Supabase migrations lean on
 * but which aren't in the PGlite / native builds. `moddatetime` (a BEFORE
 * UPDATE trigger that stamps a timestamp column) is the common one - projects
 * attach it as the updated_at trigger. Created only if absent, so a real
 * extension (where present) still wins.
 */
export const EXT_COMPAT_SQL = `
create schema if not exists extensions;
do $ensure_moddatetime$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'extensions' and p.proname = 'moddatetime'
  ) then
    execute $fn$
      create function extensions.moddatetime() returns trigger language plpgsql as $mod$
      begin
        if TG_NARGS >= 1 then
          NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], now()));
        end if;
        return NEW;
      end
      $mod$
    $fn$;
  end if;
end
$ensure_moddatetime$;
`

/**
 * Supabase Vault emulation. Real Vault (supabase_vault + pgsodium) encrypts
 * secrets at rest; we can't ship those C extensions. This stand-in keeps the
 * same surface (vault.secrets, vault.decrypted_secrets, vault.create_secret /
 * update_secret) but stores the secret encrypted with pgcrypto's authenticated
 * symmetric encryption (pgp_sym_encrypt) under a key held in the GUC
 * app.settings.vault_key, set at boot and never stored in the database.
 *
 * SECURITY: the stored `secret` column holds ciphertext; decrypted_secrets
 * decrypts on read. If pgcrypto or the key is unavailable the functions raise,
 * rather than silently falling back to cleartext.
 */
export const VAULT_SQL = `
create schema if not exists vault;
grant usage on schema vault to service_role;

create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
grant select, insert, update, delete on vault.secrets to service_role;

-- the encryption key, from the GUC set at boot (empty string if unset)
create or replace function vault._key() returns text
language sql stable as $vault$
  select coalesce(nullif(current_setting('app.settings.vault_key', true), ''), '')
$vault$;

create or replace function vault._encrypt(plain text) returns text
language plpgsql security definer set search_path = vault, extensions, pg_catalog, public as $vault$
declare k text := vault._key();
begin
  if plain is null then return null; end if;
  if k = '' then raise exception 'vault key is not configured'; end if;
  return encode(pgp_sym_encrypt(plain, k), 'base64');
end $vault$;

create or replace function vault._decrypt(cipher text) returns text
language plpgsql security definer set search_path = vault, extensions, pg_catalog, public as $vault$
declare k text := vault._key();
begin
  if cipher is null then return null; end if;
  if k = '' then raise exception 'vault key is not configured'; end if;
  return pgp_sym_decrypt(decode(cipher, 'base64'), k);
end $vault$;

create or replace view vault.decrypted_secrets as
  select id, name, description, secret, vault._decrypt(secret) as decrypted_secret, key_id, nonce, created_at, updated_at
  from vault.secrets;
grant select on vault.decrypted_secrets to service_role;

create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language plpgsql security definer set search_path = vault, pg_catalog, public as $vault$
declare rec_id uuid;
begin
  insert into vault.secrets (name, description, secret, key_id)
  values (new_name, coalesce(new_description, ''), vault._encrypt(new_secret), new_key_id)
  returning id into rec_id;
  return rec_id;
end $vault$;

create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null, new_key_id uuid default null)
returns void language plpgsql security definer set search_path = vault, pg_catalog, public as $vault$
begin
  update vault.secrets set
    secret = case when new_secret is null then secret else vault._encrypt(new_secret) end,
    name = coalesce(new_name, name),
    description = coalesce(new_description, description),
    key_id = coalesce(new_key_id, key_id),
    updated_at = now()
  where id = secret_id;
end $vault$;

grant execute on function vault.create_secret(text,text,text,uuid), vault.update_secret(uuid,text,text,text,uuid) to service_role;
`
