-- ============================================================
-- Supabase Core Schema Initialization
-- Based on supabase/postgres official migrations
-- ============================================================

-- 1. 创建 Supabase 专用 Role
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
        CREATE ROLE anon NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
        CREATE ROLE authenticated NOLOGIN NOINHERIT;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
        CREATE ROLE supabase_admin LOGIN NOINHERIT BYPASSRLS REPLICATION;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
        CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE CREATEDB;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN
        CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT;
    END IF;
END
$$;

-- Ensure existing clusters also grant replication to supabase_admin
ALTER ROLE supabase_admin WITH REPLICATION;

-- 授予 authenticator 可以切换到各角色
GRANT anon TO postgres;
GRANT authenticated TO postgres;
GRANT service_role TO postgres;
GRANT supabase_admin TO postgres;

-- 设置 supabase_auth_admin 默认 search_path (GoTrue 需要)
ALTER ROLE supabase_auth_admin SET search_path TO auth, public;

-- 2. Auth Schema
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
    instance_id UUID,
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    aud VARCHAR(255),
    role VARCHAR(255),
    email VARCHAR(255) UNIQUE,
    encrypted_password VARCHAR(255),
    email_confirmed_at TIMESTAMPTZ,
    invited_at TIMESTAMPTZ,
    confirmation_token VARCHAR(255),
    confirmation_sent_at TIMESTAMPTZ,
    recovery_token VARCHAR(255),
    recovery_sent_at TIMESTAMPTZ,
    email_change_token_new VARCHAR(255),
    email_change VARCHAR(255),
    email_change_sent_at TIMESTAMPTZ,
    last_sign_in_at TIMESTAMPTZ,
    raw_app_meta_data JSONB,
    raw_user_meta_data JSONB,
    is_super_admin BOOLEAN,
    phone VARCHAR(15) UNIQUE DEFAULT NULL,
    phone_confirmed_at TIMESTAMPTZ,
    phone_change VARCHAR(15) DEFAULT '',
    phone_change_token VARCHAR(255) DEFAULT '',
    phone_change_sent_at TIMESTAMPTZ,
    confirmed_at TIMESTAMPTZ GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current VARCHAR(255) DEFAULT '',
    email_change_confirm_status SMALLINT DEFAULT 0,
    banned_until TIMESTAMPTZ,
    reauthentication_token VARCHAR(255) DEFAULT '',
    reauthentication_sent_at TIMESTAMPTZ,
    is_sso_user BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS users_instance_id_idx ON auth.users (instance_id);
CREATE INDEX IF NOT EXISTS users_email_idx ON auth.users (email);

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
    instance_id UUID,
    id BIGSERIAL PRIMARY KEY,
    token VARCHAR(255),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    revoked BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    parent VARCHAR(255),
    session_id UUID
);
CREATE INDEX IF NOT EXISTS refresh_tokens_token_idx ON auth.refresh_tokens (token);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx ON auth.refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS auth.sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    factor_id UUID,
    aal VARCHAR(10),
    not_after TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON auth.sessions (user_id);

CREATE TABLE IF NOT EXISTS auth.identities (
    id TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    identity_data JSONB NOT NULL,
    provider TEXT NOT NULL,
    last_sign_in_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    email TEXT GENERATED ALWAYS AS (lower(identity_data->>'email')) STORED,
    CONSTRAINT identities_pkey PRIMARY KEY (provider, id)
);
CREATE INDEX IF NOT EXISTS identities_user_id_idx ON auth.identities (user_id);
CREATE INDEX IF NOT EXISTS identities_email_idx ON auth.identities (email);

-- 授权
GRANT ALL ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
GRANT SELECT ON ALL TABLES IN SCHEMA auth TO service_role;

-- 3. Storage Schema
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    owner UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    public BOOLEAN DEFAULT false,
    avif_autodetection BOOLEAN DEFAULT false,
    file_size_limit BIGINT,
    allowed_mime_types TEXT[],
    owner_id TEXT
);

CREATE TABLE IF NOT EXISTS storage.objects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket_id TEXT REFERENCES storage.buckets(id),
    name TEXT,
    owner UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_accessed_at TIMESTAMPTZ DEFAULT NOW(),
    metadata JSONB,
    path_tokens TEXT[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
    version TEXT,
    owner_id TEXT
);
CREATE INDEX IF NOT EXISTS objects_bucket_id_idx ON storage.objects (bucket_id);
CREATE UNIQUE INDEX IF NOT EXISTS objects_bucket_name_idx ON storage.objects (bucket_id, name);

-- 授权
GRANT ALL ON ALL TABLES IN SCHEMA storage TO supabase_storage_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO supabase_storage_admin;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO anon, authenticated, service_role;

-- 启用 RLS
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 4. Realtime Schema
CREATE SCHEMA IF NOT EXISTS realtime;
GRANT USAGE ON SCHEMA realtime TO anon, authenticated, service_role;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        CREATE PUBLICATION supabase_realtime;
        ALTER PUBLICATION supabase_realtime OWNER TO supabase_admin;
    END IF;
END
$$;

/*
    WALRUS:
        Write Ahead Log Realtime Unified Security
*/

create schema if not exists realtime;


create type realtime.equality_op as enum(
    'eq', 'neq', 'lt', 'lte', 'gt', 'gte'
);


create type realtime.action as enum ('INSERT', 'UPDATE', 'DELETE', 'ERROR');


create function realtime.cast(val text, type_ regtype)
    returns jsonb
    immutable
    language plpgsql
as $$
declare
    res jsonb;
begin
    execute format('select to_jsonb(%L::'|| type_::text || ')', val)  into res;
    return res;
end
$$;


create type realtime.user_defined_filter as (
    column_name text,
    op realtime.equality_op,
    value text
);


create function realtime.to_regrole(role_name text)
    returns regrole
    immutable
    language sql
    -- required to allow use in generated clause
as $$ select role_name::regrole $$;


create table realtime.subscription (
    -- Tracks which subscriptions are active
    id bigint generated always as identity primary key,
    subscription_id uuid not null,
    entity regclass not null,
    filters realtime.user_defined_filter[] not null default '{}',
    claims jsonb not null,
    claims_role regrole not null generated always as (realtime.to_regrole(claims ->> 'role')) stored,
    created_at timestamp not null default timezone('utc', now()),

    unique (subscription_id, entity, filters)
);
create index ix_realtime_subscription_entity on realtime.subscription using hash (entity);


create or replace function realtime.subscription_check_filters()
    returns trigger
    language plpgsql
as $$
/*
Validates that the user defined filters for a subscription:
- refer to valid columns that the claimed role may access
- values are coercable to the correct column type
*/
declare
    col_names text[] = coalesce(
            array_agg(c.column_name order by c.ordinal_position),
            '{}'::text[]
        )
        from
            information_schema.columns c
        where
            format('%I.%I', c.table_schema, c.table_name)::regclass = new.entity
            and pg_catalog.has_column_privilege(
                (new.claims ->> 'role'),
                format('%I.%I', c.table_schema, c.table_name)::regclass,
                c.column_name,
                'SELECT'
            );
    filter realtime.user_defined_filter;
    col_type regtype;
begin
    for filter in select * from unnest(new.filters) loop
        -- Filtered column is valid
        if not filter.column_name = any(col_names) then
            raise exception 'invalid column for filter %', filter.column_name;
        end if;

        -- Type is sanitized and safe for string interpolation
        col_type = (
            select atttypid::regtype
            from pg_catalog.pg_attribute
            where attrelid = new.entity
                  and attname = filter.column_name
        );
        if col_type is null then
            raise exception 'failed to lookup type for column %', filter.column_name;
        end if;
        -- raises an exception if value is not coercable to type
        perform realtime.cast(filter.value, col_type);
    end loop;

    -- Apply consistent order to filters so the unique constraint on
    -- (subscription_id, entity, filters) can't be tricked by a different filter order
    new.filters = coalesce(
        array_agg(f order by f.column_name, f.op, f.value),
        '{}'
    ) from unnest(new.filters) f;

    return new;
end;
$$;

create trigger tr_check_filters
    before insert or update on realtime.subscription
    for each row
    execute function realtime.subscription_check_filters();


create or replace function realtime.quote_wal2json(entity regclass)
    returns text
    language sql
    immutable
    strict
as $$
    select
        (
            select string_agg('\' || ch,'')
            from unnest(string_to_array(nsp.nspname::text, null)) with ordinality x(ch, idx)
            where
                not (x.idx = 1 and x.ch = '"')
                and not (
                    x.idx = array_length(string_to_array(nsp.nspname::text, null), 1)
                    and x.ch = '"'
                )
        )
        || '.'
        || (
            select string_agg('\' || ch,'')
            from unnest(string_to_array(pc.relname::text, null)) with ordinality x(ch, idx)
            where
                not (x.idx = 1 and x.ch = '"')
                and not (
                    x.idx = array_length(string_to_array(nsp.nspname::text, null), 1)
                    and x.ch = '"'
                )
        )
    from
        pg_class pc
        join pg_namespace nsp
            on pc.relnamespace = nsp.oid
    where
        pc.oid = entity
$$;


create or replace function realtime.check_equality_op(
    op realtime.equality_op,
    type_ regtype,
    val_1 text,
    val_2 text
)
    returns bool
    immutable
    language plpgsql
as $$
/*
Casts *val_1* and *val_2* as type *type_* and check the *op* condition for truthiness
*/
declare
    op_symbol text = (
        case
            when op = 'eq' then '='
            when op = 'neq' then '!='
            when op = 'lt' then '<'
            when op = 'lte' then '<='
            when op = 'gt' then '>'
            when op = 'gte' then '>='
            else 'UNKNOWN OP'
        end
    );
    res boolean;
begin
    execute format('select %L::'|| type_::text || ' ' || op_symbol || ' %L::'|| type_::text, val_1, val_2) into res;
    return res;
end;
$$;


create type realtime.wal_column as (
    name text,
    type_name text,
    type_oid oid,
    value jsonb,
    is_pkey boolean,
    is_selectable boolean
);

create or replace function realtime.build_prepared_statement_sql(
    prepared_statement_name text,
    entity regclass,
    columns realtime.wal_column[]
)
    returns text
    language sql
as $$
/*
Builds a sql string that, if executed, creates a prepared statement to
tests retrive a row from *entity* by its primary key columns.

Example
    select realtime.build_prepared_statement_sql('public.notes', '{"id"}'::text[], '{"bigint"}'::text[])
*/
    select
'prepare ' || prepared_statement_name || ' as
    select
        exists(
            select
                1
            from
                ' || entity || '
            where
                ' || string_agg(quote_ident(pkc.name) || '=' || quote_nullable(pkc.value #>> '{}') , ' and ') || '
        )'
    from
        unnest(columns) pkc
    where
        pkc.is_pkey
    group by
        entity
$$;


create type realtime.wal_rls as (
    wal jsonb,
    is_rls_enabled boolean,
    subscription_ids uuid[],
    errors text[]
);



create or replace function realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[])
    returns bool
    language sql
    immutable
as $$
/*
Should the record be visible (true) or filtered out (false) after *filters* are applied
*/
    select
        -- Default to allowed when no filters present
        coalesce(
            sum(
                realtime.check_equality_op(
                    op:=f.op,
                    type_:=col.type_oid::regtype,
                    -- cast jsonb to text
                    val_1:=col.value #>> '{}',
                    val_2:=f.value
                )::int
            ) = count(1),
            true
        )
    from
        unnest(filters) f
        join unnest(columns) col
            on f.column_name = col.name;
$$;


create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    (x->>'typeoid')::regtype
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    (x->>'typeoid')::regtype
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    (wal ->> 'timestamp')::timestamptz,
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    case
                        when error_record_exceeds_max_size then
                            jsonb_build_object(
                                'record',
                                (
                                    select jsonb_object_agg((c).name, (c).value)
                                    from unnest(columns) c
                                    where (c).is_selectable and (octet_length((c).value::text) <= 64)
                                )
                            )
                        else
                            jsonb_build_object(
                                'record',
                                (select jsonb_object_agg((c).name, (c).value) from unnest(columns) c where (c).is_selectable)
                            )
                    end
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action in ('UPDATE', 'DELETE') then
                    case
                        when error_record_exceeds_max_size then
                            jsonb_build_object(
                                'old_record',
                                (
                                    select jsonb_object_agg((c).name, (c).value)
                                    from unnest(old_columns) c
                                    where (c).is_selectable and (octet_length((c).value::text) <= 64)
                                )
                            )
                        else
                            jsonb_build_object(
                                'old_record',
                                (select jsonb_object_agg((c).name, (c).value) from unnest(old_columns) c where (c).is_selectable)
                            )
                    end
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and realtime.is_visible_through_filters(columns, subs.filters)
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        set_config('role', working_role::text, true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
create or replace function realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[])
    returns bool
    language sql
    immutable
as $$
/*
Should the record be visible (true) or filtered out (false) after *filters* are applied
*/
    select
        -- Default to allowed when no filters present
        coalesce(
            sum(
                realtime.check_equality_op(
                    op:=f.op,
                    type_:=coalesce(
                        col.type_oid::regtype, -- null when wal2json version <= 2.4
                        col.type_name::regtype
                    ),
                    -- cast jsonb to text
                    val_1:=col.value #>> '{}',
                    val_2:=f.value
                )::int
            ) = count(1),
            true
        )
    from
        unnest(filters) f
        join unnest(columns) col
            on f.column_name = col.name;
$$;


create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    (wal ->> 'timestamp')::timestamptz,
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    case
                        when error_record_exceeds_max_size then
                            jsonb_build_object(
                                'record',
                                (
                                    select jsonb_object_agg((c).name, (c).value)
                                    from unnest(columns) c
                                    where (c).is_selectable and (octet_length((c).value::text) <= 64)
                                )
                            )
                        else
                            jsonb_build_object(
                                'record',
                                (select jsonb_object_agg((c).name, (c).value) from unnest(columns) c where (c).is_selectable)
                            )
                    end
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action in ('UPDATE', 'DELETE') then
                    case
                        when error_record_exceeds_max_size then
                            jsonb_build_object(
                                'old_record',
                                (
                                    select jsonb_object_agg((c).name, (c).value)
                                    from unnest(old_columns) c
                                    where (c).is_selectable and (octet_length((c).value::text) <= 64)
                                )
                            )
                        else
                            jsonb_build_object(
                                'old_record',
                                (select jsonb_object_agg((c).name, (c).value) from unnest(old_columns) c where (c).is_selectable)
                            )
                    end
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and realtime.is_visible_through_filters(columns, subs.filters)
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        set_config('role', working_role::text, true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
create or replace function realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[])
    returns bool
    language sql
    immutable
as $$
/*
Should the record be visible (true) or filtered out (false) after *filters* are applied
*/
    select
        -- Default to allowed when no filters present
        $2 is null -- no filters. this should not happen because subscriptions has a default
        or array_length($2, 1) is null -- array length of an empty array is null... wtf
        or bool_and(
            coalesce(
                realtime.check_equality_op(
                    op:=f.op,
                    type_:=coalesce(
                        col.type_oid::regtype, -- null when wal2json version <= 2.4
                        col.type_name::regtype
                    ),
                    -- cast jsonb to text
                    val_1:=col.value #>> '{}',
                    val_2:=f.value
                ),
                false -- if null, filter does not match
            )
        )
    from
        unnest(filters) f
        join unnest(columns) col
            on f.column_name = col.name;
$$;
create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    (wal ->> 'timestamp')::timestamptz,
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    case
                        when error_record_exceeds_max_size then
                            jsonb_build_object(
                                'record',
                                (
                                    select jsonb_object_agg((c).name, (c).value)
                                    from unnest(columns) c
                                    where (c).is_selectable and (octet_length((c).value::text) <= 64)
                                )
                            )
                        else
                            jsonb_build_object(
                                'record',
                                (select jsonb_object_agg((c).name, (c).value) from unnest(columns) c where (c).is_selectable)
                            )
                    end
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action in ('UPDATE', 'DELETE') then
                    case
                        when error_record_exceeds_max_size then
                            jsonb_build_object(
                                'old_record',
                                (
                                    select jsonb_object_agg((c).name, (c).value)
                                    from unnest(old_columns) c
                                    where (c).is_selectable and (octet_length((c).value::text) <= 64)
                                )
                            )
                        else
                            jsonb_build_object(
                                'old_record',
                                (select jsonb_object_agg((c).name, (c).value) from unnest(old_columns) c where (c).is_selectable)
                            )
                    end
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or action = 'DELETE'
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        set_config('role', working_role::text, true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
alter type realtime.equality_op add value 'in';

create or replace function realtime.check_equality_op(
    op realtime.equality_op,
    type_ regtype,
    val_1 text,
    val_2 text
)
    returns bool
    immutable
    language plpgsql
as $$
/*
Casts *val_1* and *val_2* as type *type_* and check the *op* condition for truthiness
*/
declare
    op_symbol text = (
        case
            when op = 'eq' then '='
            when op = 'neq' then '!='
            when op = 'lt' then '<'
            when op = 'lte' then '<='
            when op = 'gt' then '>'
            when op = 'gte' then '>='
            when op = 'in' then '= any'
            else 'UNKNOWN OP'
        end
    );
    res boolean;
begin
    execute format(
        'select %L::'|| type_::text || ' ' || op_symbol
        || ' ( %L::'
        || (
            case
                when op = 'in' then type_::text || '[]'
                else type_::text end
        )
        || ')', val_1, val_2) into res;
    return res;
end;
$$;


create or replace function realtime.subscription_check_filters()
    returns trigger
    language plpgsql
as $$
/*
Validates that the user defined filters for a subscription:
- refer to valid columns that the claimed role may access
- values are coercable to the correct column type
*/
declare
    col_names text[] = coalesce(
            array_agg(c.column_name order by c.ordinal_position),
            '{}'::text[]
        )
        from
            information_schema.columns c
        where
            format('%I.%I', c.table_schema, c.table_name)::regclass = new.entity
            and pg_catalog.has_column_privilege(
                (new.claims ->> 'role'),
                format('%I.%I', c.table_schema, c.table_name)::regclass,
                c.column_name,
                'SELECT'
            );
    filter realtime.user_defined_filter;
    col_type regtype;

    in_val jsonb;
begin
    for filter in select * from unnest(new.filters) loop
        -- Filtered column is valid
        if not filter.column_name = any(col_names) then
            raise exception 'invalid column for filter %', filter.column_name;
        end if;

        -- Type is sanitized and safe for string interpolation
        col_type = (
            select atttypid::regtype
            from pg_catalog.pg_attribute
            where attrelid = new.entity
                  and attname = filter.column_name
        );
        if col_type is null then
            raise exception 'failed to lookup type for column %', filter.column_name;
        end if;

        -- Set maximum number of entries for in filter
        if filter.op = 'in'::realtime.equality_op then
            in_val = realtime.cast(filter.value, (col_type::text || '[]')::regtype);
            if coalesce(jsonb_array_length(in_val), 0) > 100 then
                raise exception 'too many values for `in` filter. Maximum 100';
            end if;
        end if;

        -- raises an exception if value is not coercable to type
        perform realtime.cast(filter.value, col_type);
    end loop;

    -- Apply consistent order to filters so the unique constraint on
    -- (subscription_id, entity, filters) can't be tricked by a different filter order
    new.filters = coalesce(
        array_agg(f order by f.column_name, f.op, f.value),
        '{}'
    ) from unnest(new.filters) f;

    return new;
end;
$$;
create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    (wal ->> 'timestamp')::timestamptz,
                    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    jsonb_build_object(
                        'record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action = 'UPDATE' then
                    jsonb_build_object(
                            'old_record',
                            (
                                select jsonb_object_agg((c).name, (c).value)
                                from unnest(old_columns) c
                                where
                                    (c).is_selectable
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            )
                        )
                when action = 'DELETE' then
                    jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                        )
                    )
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or action = 'DELETE'
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        set_config('role', working_role::text, true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    (wal ->> 'timestamp')::timestamptz,
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    jsonb_build_object(
                        'record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action = 'UPDATE' then
                    jsonb_build_object(
                            'old_record',
                            (
                                select jsonb_object_agg((c).name, (c).value)
                                from unnest(old_columns) c
                                where
                                    (c).is_selectable
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            )
                        )
                when action = 'DELETE' then
                    jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                        )
                    )
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or action = 'DELETE'
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        set_config('role', working_role::text, true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    ((wal ->> 'timestamp')::timestamptz at time zone 'utc'),
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    jsonb_build_object(
                        'record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action = 'UPDATE' then
                    jsonb_build_object(
                            'old_record',
                            (
                                select jsonb_object_agg((c).name, (c).value)
                                from unnest(old_columns) c
                                where
                                    (c).is_selectable
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            )
                        )
                when action = 'DELETE' then
                    jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                        )
                    )
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or action = 'DELETE'
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        set_config('role', working_role::text, true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
create or replace function realtime.subscription_check_filters()
    returns trigger
    language plpgsql
as $$
/*
Validates that the user defined filters for a subscription:
- refer to valid columns that the claimed role may access
- values are coercable to the correct column type
*/
declare
    col_names text[] = coalesce(
            array_agg(c.column_name order by c.ordinal_position),
            '{}'::text[]
        )
        from
            information_schema.columns c
        where
            format('%I.%I', c.table_schema, c.table_name)::regclass = new.entity
            and pg_catalog.has_column_privilege(
                (new.claims ->> 'role'),
                format('%I.%I', c.table_schema, c.table_name)::regclass,
                c.column_name,
                'SELECT'
            );
    filter realtime.user_defined_filter;
    col_type regtype;

    in_val jsonb;
begin
    for filter in select * from unnest(new.filters) loop
        -- Filtered column is valid
        if not filter.column_name = any(col_names) then
            raise exception 'invalid column for filter %', filter.column_name;
        end if;

        -- Type is sanitized and safe for string interpolation
        col_type = (
            select atttypid::regtype
            from pg_catalog.pg_attribute
            where attrelid = new.entity
                  and attname = filter.column_name
        );
        if col_type is null then
            raise exception 'failed to lookup type for column %', filter.column_name;
        end if;

        -- Set maximum number of entries for in filter
        if filter.op = 'in'::realtime.equality_op then
            in_val = realtime.cast(filter.value, (col_type::text || '[]')::regtype);
            if coalesce(jsonb_array_length(in_val), 0) > 100 then
                raise exception 'too many values for `in` filter. Maximum 100';
            end if;
        else
            -- raises an exception if value is not coercable to type
            perform realtime.cast(filter.value, col_type);
        end if;

    end loop;

    -- Apply consistent order to filters so the unique constraint on
    -- (subscription_id, entity, filters) can't be tricked by a different filter order
    new.filters = coalesce(
        array_agg(f order by f.column_name, f.op, f.value),
        '{}'
    ) from unnest(new.filters) f;

    return new;
end;
$$;
create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    ((wal ->> 'timestamp')::timestamptz at time zone 'utc'),
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    jsonb_build_object(
                        'record',
                        (
                            select
                                jsonb_object_agg(
                                    -- if unchanged toast, get column name and value from old record
                                    coalesce((c).name, (oc).name),
                                    case
                                        when (c).name is null then (oc).value
                                        else (c).value
                                    end
                                )
                            from
                                unnest(columns) c
                                full outer join unnest(old_columns) oc
                                    on (c).name = (oc).name
                            where
                                coalesce((c).is_selectable, (oc).is_selectable)
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action = 'UPDATE' then
                    jsonb_build_object(
                            'old_record',
                            (
                                select jsonb_object_agg((c).name, (c).value)
                                from unnest(old_columns) c
                                where
                                    (c).is_selectable
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            )
                        )
                when action = 'DELETE' then
                    jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                        )
                    )
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or action = 'DELETE'
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        set_config('role', working_role::text, true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role::text)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    ((wal ->> 'timestamp')::timestamptz at time zone 'utc'),
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    jsonb_build_object(
                        'record',
                        (
                            select
                                jsonb_object_agg(
                                    -- if unchanged toast, get column name and value from old record
                                    coalesce((c).name, (oc).name),
                                    case
                                        when (c).name is null then (oc).value
                                        else (c).value
                                    end
                                )
                            from
                                unnest(columns) c
                                full outer join unnest(old_columns) oc
                                    on (c).name = (oc).name
                            where
                                coalesce((c).is_selectable, (oc).is_selectable)
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action = 'UPDATE' then
                    jsonb_build_object(
                            'old_record',
                            (
                                select jsonb_object_agg((c).name, (c).value)
                                from unnest(old_columns) c
                                where
                                    (c).is_selectable
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            )
                        )
                when action = 'DELETE' then
                    jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                        )
                    )
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or action = 'DELETE'
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        -- Trim leading and trailing quotes from working_role because set_config
                        -- doesn't recognize the role as valid if they are included
                        set_config('role', trim(both '"' from working_role::text), true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_;

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role::text)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    ((wal ->> 'timestamp')::timestamptz at time zone 'utc'),
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    jsonb_build_object(
                        'record',
                        (
                            select
                                jsonb_object_agg(
                                    -- if unchanged toast, get column name and value from old record
                                    coalesce((c).name, (oc).name),
                                    case
                                        when (c).name is null then (oc).value
                                        else (c).value
                                    end
                                )
                            from
                                unnest(columns) c
                                full outer join unnest(old_columns) oc
                                    on (c).name = (oc).name
                            where
                                coalesce((c).is_selectable, (oc).is_selectable)
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action = 'UPDATE' then
                    jsonb_build_object(
                            'old_record',
                            (
                                select jsonb_object_agg((c).name, (c).value)
                                from unnest(old_columns) c
                                where
                                    (c).is_selectable
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            )
                        )
                when action = 'DELETE' then
                    jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                        )
                    )
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or (
                              action = 'DELETE'
                              and realtime.is_visible_through_filters(old_columns, subs.filters)
                            )
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        -- Trim leading and trailing quotes from working_role because set_config
                        -- doesn't recognize the role as valid if they are included
                        set_config('role', trim(both '"' from working_role::text), true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;
ALTER TABLE realtime.subscription
ADD COLUMN action_filter text DEFAULT '*' CHECK (action_filter IN ('*', 'INSERT', 'UPDATE', 'DELETE'));

create or replace function realtime.apply_rls(wal jsonb, max_record_bytes int = 1024 * 1024)
    returns setof realtime.wal_rls
    language plpgsql
    volatile
as $$
declare
    -- Regclass of the table e.g. public.notes
    entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

    -- I, U, D, T: insert, update ...
    action realtime.action = (
        case wal ->> 'action'
            when 'I' then 'INSERT'
            when 'U' then 'UPDATE'
            when 'D' then 'DELETE'
            else 'ERROR'
        end
    );

    -- Is row level security enabled for the table
    is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

    subscriptions realtime.subscription[] = array_agg(subs)
        from
            realtime.subscription subs
        where
            subs.entity = entity_
            -- Filter by action early - only get subscriptions interested in this action
            -- action_filter column can be: '*' (all), 'INSERT', 'UPDATE', or 'DELETE'
            and (subs.action_filter = '*' or subs.action_filter = action::text);

    -- Subscription vars
    roles regrole[] = array_agg(distinct us.claims_role::text)
        from
            unnest(subscriptions) us;

    working_role regrole;
    claimed_role regrole;
    claims jsonb;

    subscription_id uuid;
    subscription_has_access bool;
    visible_to_subscription_ids uuid[] = '{}';

    -- structured info for wal's columns
    columns realtime.wal_column[];
    -- previous identity values for update/delete
    old_columns realtime.wal_column[];

    error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

    -- Primary jsonb output for record
    output jsonb;

begin
    perform set_config('role', null, true);

    columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'columns') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    old_columns =
        array_agg(
            (
                x->>'name',
                x->>'type',
                x->>'typeoid',
                realtime.cast(
                    (x->'value') #>> '{}',
                    coalesce(
                        (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                        (x->>'type')::regtype
                    )
                ),
                (pks ->> 'name') is not null,
                true
            )::realtime.wal_column
        )
        from
            jsonb_array_elements(wal -> 'identity') x
            left join jsonb_array_elements(wal -> 'pk') pks
                on (x ->> 'name') = (pks ->> 'name');

    for working_role in select * from unnest(roles) loop

        -- Update `is_selectable` for columns and old_columns
        columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(columns) c;

        old_columns =
                array_agg(
                    (
                        c.name,
                        c.type_name,
                        c.type_oid,
                        c.value,
                        c.is_pkey,
                        pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                    )::realtime.wal_column
                )
                from
                    unnest(old_columns) c;

        if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                -- subscriptions is already filtered by entity
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 400: Bad Request, no primary key']
            )::realtime.wal_rls;

        -- The claims role does not have SELECT permission to the primary key of entity
        elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
            return next (
                jsonb_build_object(
                    'schema', wal ->> 'schema',
                    'table', wal ->> 'table',
                    'type', action
                ),
                is_rls_enabled,
                (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
                array['Error 401: Unauthorized']
            )::realtime.wal_rls;

        else
            output = jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action,
                'commit_timestamp', to_char(
                    ((wal ->> 'timestamp')::timestamptz at time zone 'utc'),
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ),
                'columns', (
                    select
                        jsonb_agg(
                            jsonb_build_object(
                                'name', pa.attname,
                                'type', pt.typname
                            )
                            order by pa.attnum asc
                        )
                    from
                        pg_attribute pa
                        join pg_type pt
                            on pa.atttypid = pt.oid
                    where
                        attrelid = entity_
                        and attnum > 0
                        and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
                )
            )
            -- Add "record" key for insert and update
            || case
                when action in ('INSERT', 'UPDATE') then
                    jsonb_build_object(
                        'record',
                        (
                            select
                                jsonb_object_agg(
                                    -- if unchanged toast, get column name and value from old record
                                    coalesce((c).name, (oc).name),
                                    case
                                        when (c).name is null then (oc).value
                                        else (c).value
                                    end
                                )
                            from
                                unnest(columns) c
                                full outer join unnest(old_columns) oc
                                    on (c).name = (oc).name
                            where
                                coalesce((c).is_selectable, (oc).is_selectable)
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
                else '{}'::jsonb
            end
            -- Add "old_record" key for update and delete
            || case
                when action = 'UPDATE' then
                    jsonb_build_object(
                            'old_record',
                            (
                                select jsonb_object_agg((c).name, (c).value)
                                from unnest(old_columns) c
                                where
                                    (c).is_selectable
                                    and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            )
                        )
                when action = 'DELETE' then
                    jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                                and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                        )
                    )
                else '{}'::jsonb
            end;

            -- Create the prepared statement
            if is_rls_enabled and action <> 'DELETE' then
                if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                    deallocate walrus_rls_stmt;
                end if;
                execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
            end if;

            visible_to_subscription_ids = '{}';

            for subscription_id, claims in (
                    select
                        subs.subscription_id,
                        subs.claims
                    from
                        unnest(subscriptions) subs
                    where
                        subs.entity = entity_
                        and subs.claims_role = working_role
                        and (
                            realtime.is_visible_through_filters(columns, subs.filters)
                            or (
                              action = 'DELETE'
                              and realtime.is_visible_through_filters(old_columns, subs.filters)
                            )
                        )
            ) loop

                if not is_rls_enabled or action = 'DELETE' then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                else
                    -- Check if RLS allows the role to see the record
                    perform
                        -- Trim leading and trailing quotes from working_role because set_config
                        -- doesn't recognize the role as valid if they are included
                        set_config('role', trim(both '"' from working_role::text), true),
                        set_config('request.jwt.claims', claims::text, true);

                    execute 'execute walrus_rls_stmt' into subscription_has_access;

                    if subscription_has_access then
                        visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                    end if;
                end if;
            end loop;

            perform set_config('role', null, true);

            return next (
                output,
                is_rls_enabled,
                visible_to_subscription_ids,
                case
                    when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                    else '{}'
                end
            )::realtime.wal_rls;

        end if;
    end loop;

    perform set_config('role', null, true);
end;
$$;


GRANT SELECT, INSERT, UPDATE, DELETE ON realtime.messages TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON realtime.subscription TO anon, authenticated, service_role;

-- 5. Public Schema 权限
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;

-- 6. Supabase SQL Helpers
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid AS $$
BEGIN
  RETURN COALESCE(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
EXCEPTION
  WHEN invalid_text_representation THEN
    RETURN NULL;
END
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text AS $$
  SELECT COALESCE(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  )
  SELECT arr[1:array_length(arr, 1)-1] FROM parts;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  )
  SELECT arr[array_length(arr, 1)] FROM parts;
$$ LANGUAGE SQL STABLE;

CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text AS $$
  WITH parts AS (
    SELECT string_to_array(name, '/') AS arr
  ),
  filename AS (
    SELECT arr[array_length(arr, 1)] AS f FROM parts
  )
  SELECT substring(f FROM '\.([^\.]*)$') FROM filename;
$$ LANGUAGE SQL STABLE;

-- 7. GraphQL Schema
CREATE SCHEMA IF NOT EXISTS graphql_public;
GRANT USAGE ON SCHEMA graphql_public TO anon, authenticated, service_role;
