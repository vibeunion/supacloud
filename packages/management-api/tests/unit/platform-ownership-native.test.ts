import { expect, test } from "bun:test";
import { SQL } from "bun";
import { randomUUID } from "node:crypto";
import { startStarterPostgres } from "../../../../scripts/lib/starter-postgres";
import {
  PLATFORM_PUBLIC_ROUTINES,
  repairPlatformRpcOwnership,
} from "../../src/services/platform-ownership";
import { prepareProjectMigrationRole } from "../../src/services/project-migration-role";

const postgresBin = process.env.SUPACLOUD_STARTER_POSTGRES_BIN;

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function publicSignature(name: string): string {
  return `public.${name}(jsonb)`;
}

function ownershipRowsSql(): string {
  const signatures = PLATFORM_PUBLIC_ROUTINES.map(([name]) => quoteLiteral(publicSignature(name))).join(", ");
  return `
    SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef,
           p.proacl::text AS acl
    FROM pg_proc p
    WHERE p.oid IN (
      SELECT to_regprocedure(signature)
      FROM unnest(ARRAY[${signatures}]) AS signature
    )
    ORDER BY p.proname
  `;
}

function createFixtureSql(projectOwner: string, servicePassword: string): string {
  const privateSchemas = [...new Set(PLATFORM_PUBLIC_ROUTINES.map(([, schema]) => schema))];
  const schemaSql = privateSchemas.map((schema) => `
    CREATE ROLE ${quoteIdentifier(`${schema}_owner`)} NOLOGIN;
    CREATE SCHEMA ${quoteIdentifier(schema)} AUTHORIZATION ${quoteIdentifier(`${schema}_owner`)};
    REVOKE ALL ON SCHEMA ${quoteIdentifier(schema)} FROM PUBLIC;
    GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO service_role;
  `).join("\n");
  const privateFunctions = PLATFORM_PUBLIC_ROUTINES.map(([name, schema]) => `
    CREATE FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier(name)}(request jsonb)
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('request', request, 'routine', ${quoteLiteral(name)}, 'owner', current_user)
    $$;
    ALTER FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier(name)}(jsonb)
      OWNER TO ${quoteIdentifier(`${schema}_owner`)};
    REVOKE ALL ON FUNCTION ${quoteIdentifier(schema)}.${quoteIdentifier(name)}(jsonb)
      FROM PUBLIC, anon, authenticated, service_role, ${quoteIdentifier(projectOwner)};
  `).join("\n");
  // Probe bodies isolate ownership/ACL behavior from workflow and queue business dependencies.
  const publicFunctions = PLATFORM_PUBLIC_ROUTINES.map(([name, schema]) => `
      CREATE FUNCTION public.${quoteIdentifier(name)}(request jsonb)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
        BEGIN RETURN ${quoteIdentifier(schema)}.${quoteIdentifier(name)}(request); END
      $$;
      ALTER FUNCTION public.${quoteIdentifier(name)}(jsonb) OWNER TO ${quoteIdentifier(projectOwner)};
      REVOKE ALL ON FUNCTION public.${quoteIdentifier(name)}(jsonb) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.${quoteIdentifier(name)}(jsonb) TO service_role;
    `).join("\n");
  return `
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE wrong_owner NOLOGIN;
    CREATE ROLE ${quoteIdentifier(projectOwner)} NOLOGIN;
    CREATE ROLE service_role LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      PASSWORD ${quoteLiteral(servicePassword)};
    GRANT USAGE ON SCHEMA public TO service_role;
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (
      version bigint PRIMARY KEY, statements text[], name text, checksum text, inserted_at timestamptz
    );
    CREATE TABLE public.schema_migrations (
      version bigint PRIMARY KEY, statements text[], name text, checksum text, inserted_at timestamptz
    );
    ${schemaSql}
    ${privateFunctions}
    ${publicFunctions}
    CREATE FUNCTION public.supacloud_workflow_start(request text)
    RETURNS text LANGUAGE sql AS $$ SELECT request $$;
    -- This ordinary overload must be transferred by project-role preparation.
    ALTER FUNCTION public.supacloud_workflow_start(text) OWNER TO wrong_owner;
  `;
}

function roleConnection(baseUrl: string, role: string, password: string): SQL {
  const url = new URL(baseUrl);
  url.username = role;
  url.password = password;
  return new SQL({ url: url.href, max: 1, connectionTimeout: 5 });
}

async function expectPermissionDenied(database: SQL, statement: string): Promise<void> {
  // Start Bun's lazy SQL query before passing its rejection to the assertion.
  const execution = (async () => { await database.unsafe(statement); })();
  await expect(execution).rejects.toMatchObject({ errno: "42501" });
}

interface OwnershipRow {
  proname: string;
  owner: string;
  prosecdef: boolean;
  acl: string | null;
}

test.skipIf(!postgresBin)("platform RPC ownership repairs only the 14 wrappers and preserves private access boundaries", async () => {
  const postgres = await startStarterPostgres(postgresBin!);
  const projectOwner = `project_owner_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const servicePassword = randomUUID();
  let database: SQL | undefined;
  let serviceRole: SQL | undefined;
  try {
    database = await postgres.withConnection(async (url) => new SQL({ url, max: 1 }));
    await database.unsafe(createFixtureSql(projectOwner, servicePassword));
    serviceRole = await postgres.withConnection(async (url) =>
      roleConnection(url, "service_role", servicePassword));
    const [identity] = await serviceRole`
      SELECT session_user, current_user, rolsuper, rolcreatedb, rolcreaterole
      FROM pg_roles WHERE rolname = current_user
    `;
    expect(identity).toEqual({
      session_user: "service_role", current_user: "service_role",
      rolsuper: false, rolcreatedb: false, rolcreaterole: false,
    });

    expect(PLATFORM_PUBLIC_ROUTINES).toHaveLength(14);
    const before = await database.unsafe<OwnershipRow[]>(ownershipRowsSql());
    expect(before).toHaveLength(14);
    expect(before.every((row) => row.owner === projectOwner && row.prosecdef)).toBe(true);
    for (const [name] of PLATFORM_PUBLIC_ROUTINES) {
      await expectPermissionDenied(serviceRole, `SELECT public.${quoteIdentifier(name)}('{}'::jsonb)`);
    }

    await database.unsafe(`
      ALTER FUNCTION public.supacloud_workflow_claim(jsonb) OWNER TO wrong_owner;
      ALTER FUNCTION public.supacloud_workflow_claim(jsonb) SECURITY INVOKER;
    `);
    const invalid = await database.unsafe<OwnershipRow[]>(ownershipRowsSql());
    await expect(repairPlatformRpcOwnership(database))
      .rejects.toThrow("PLATFORM_RPC_OWNERSHIP_CONTEXT_INVALID");
    expect(await database.unsafe<OwnershipRow[]>(ownershipRowsSql())).toEqual(invalid);

    await database.unsafe(`
      ALTER FUNCTION public.supacloud_workflow_claim(jsonb) SECURITY DEFINER;
    `);
    await repairPlatformRpcOwnership(database);
    const firstRepair = await database.unsafe<OwnershipRow[]>(ownershipRowsSql());
    await repairPlatformRpcOwnership(database);
    expect(await database.unsafe<OwnershipRow[]>(ownershipRowsSql())).toEqual(firstRepair);
    await prepareProjectMigrationRole(database, "postgres", projectOwner);
    await prepareProjectMigrationRole(database, "postgres", projectOwner);

    const repaired = await database.unsafe<OwnershipRow[]>(ownershipRowsSql());
    expect(repaired).toHaveLength(14);
    expect(repaired).toEqual(firstRepair);
    for (const [name, schema] of PLATFORM_PUBLIC_ROUTINES) {
      expect(repaired.find((row) => row.proname === name)).toMatchObject({
        owner: `${schema}_owner`, prosecdef: true,
      });
      const [result] = await serviceRole.unsafe<{ payload: unknown }[]>(
        `SELECT public.${quoteIdentifier(name)}($1::jsonb) AS payload`,
        [{ marker: name }],
      );
      expect(result?.payload).toEqual({
        request: { marker: name }, routine: name, owner: `${schema}_owner`,
      });
      // Schema USAGE is granted, so this must fail on the private routine's EXECUTE ACL.
      await expectPermissionDenied(serviceRole,
        `SELECT ${quoteIdentifier(schema)}.${quoteIdentifier(name)}('{}'::jsonb)`);
      const [privateOwner] = await database.unsafe<{ owner: string }[]>(`
        SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
        WHERE oid = to_regprocedure($1)
      `, [`${schema}.${name}(jsonb)`]);
      expect(privateOwner?.owner).toBe(`${schema}_owner`);
    }

    const [ordinaryOverload] = await database.unsafe<{ owner: string }[]>(`
      SELECT pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p
      WHERE p.oid = to_regprocedure('public.supacloud_workflow_start(text)')
    `);
    expect(ordinaryOverload?.owner).toBe(projectOwner);
    const [ordinaryResult] = await serviceRole`
      SELECT public.supacloud_workflow_start('ordinary overload'::text) AS value
    `;
    expect(ordinaryResult.value).toBe("ordinary overload");
  } finally {
    try {
      await Promise.all([database?.close({ timeout: 1 }), serviceRole?.close({ timeout: 1 })]);
    } finally {
      await postgres.close();
    }
  }
}, 60_000);
