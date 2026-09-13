import type { TransactionSQL } from "bun";

export async function reconcileGraphqlEntrypoint(transaction: TransactionSQL): Promise<void> {
    await transaction.unsafe(`
        DO $graphql_entrypoint$
        DECLARE
            current_wrapper oid := to_regprocedure('graphql_public.graphql(text,text,jsonb,jsonb)');
            legacy_wrapper oid := to_regprocedure('graphql_public.graphql(text,text,jsonb)');
            legacy_acl aclitem[];
            permission record;
        BEGIN
            CREATE SCHEMA IF NOT EXISTS graphql_public;
            IF current_wrapper IS NULL AND legacy_wrapper IS NOT NULL THEN
                SELECT coalesce(proacl, acldefault('f', proowner)) INTO legacy_acl
                FROM pg_proc WHERE oid = legacy_wrapper;
            END IF;

            -- Never use CASCADE: dependent application objects must abort and roll back the repair.
            DROP FUNCTION IF EXISTS graphql_public.graphql(text,text,jsonb);
            CREATE OR REPLACE FUNCTION graphql_public.graphql(
                "operationName" text DEFAULT NULL,
                query text DEFAULT NULL,
                variables jsonb DEFAULT NULL,
                extensions jsonb DEFAULT NULL
            ) RETURNS jsonb
            LANGUAGE sql VOLATILE SECURITY INVOKER
            AS $body$
                SELECT graphql.resolve(query, variables, "operationName", extensions);
            $body$;

            REVOKE ALL ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) FROM PUBLIC;
            IF current_wrapper IS NULL THEN
                -- Default privileges for newly-created functions must not widen a migrated ACL.
                FOR permission IN
                    SELECT r.rolname
                    FROM pg_proc p
                    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    JOIN pg_roles r ON r.oid = a.grantee
                    WHERE p.oid = 'graphql_public.graphql(text,text,jsonb,jsonb)'::regprocedure
                      AND a.grantee <> p.proowner
                LOOP
                    EXECUTE format(
                        'REVOKE ALL ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) FROM %I',
                        permission.rolname
                    );
                END LOOP;
                IF legacy_wrapper IS NULL THEN
                    GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb)
                        TO anon, authenticated, service_role;
                ELSE
                    -- Preserve restricted legacy grants instead of restoring default API-role access.
                    FOR permission IN
                        SELECT r.rolname, a.is_grantable
                        FROM aclexplode(legacy_acl) a JOIN pg_roles r ON r.oid = a.grantee
                        WHERE a.privilege_type = 'EXECUTE'
                    LOOP
                        EXECUTE format(
                            'GRANT EXECUTE ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) TO %I%s',
                            permission.rolname,
                            CASE WHEN permission.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
                        );
                    END LOOP;
                END IF;
            END IF;

            -- Invoker execution needs only these entrypoint privileges, never table grants or RLS changes.
            FOR permission IN
                SELECT r.rolname
                FROM pg_proc p
                CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                JOIN pg_roles r ON r.oid = a.grantee
                WHERE p.oid = 'graphql_public.graphql(text,text,jsonb,jsonb)'::regprocedure
                  AND a.privilege_type = 'EXECUTE'
            LOOP
                EXECUTE format('GRANT USAGE ON SCHEMA graphql, graphql_public TO %I', permission.rolname);
                EXECUTE format(
                    'GRANT EXECUTE ON FUNCTION graphql.resolve(text,jsonb,text,jsonb) TO %I',
                    permission.rolname
                );
            END LOOP;
        END;
        $graphql_entrypoint$;
    `);
}
