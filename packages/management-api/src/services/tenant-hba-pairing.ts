import { assertValidDbName, assertValidIdentifier } from "../utils/validation";

/**
 * Pigsty HBA admits authenticator_<ref> / role_<ref> only through PostgreSQL
 * `samerole`: the login must be a member of the NOLOGIN role whose name is the
 * database name. Membership is not privilege inheritance and not SET ROLE.
 */

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(identifier: string): string {
  return `'${identifier.replaceAll("'", "''")}'`;
}

export function renderTenantHbaPairingSql(
  dbName: string,
  dbUser: string,
  authenticatorRole: string,
): string {
  assertValidDbName("dbName", dbName);
  assertValidIdentifier("dbUser", dbUser);
  assertValidIdentifier("authenticatorRole", authenticatorRole);
  const anchor = quoteIdent(dbName);
  const anchorLiteral = quoteLiteral(dbName);
  const user = quoteIdent(dbUser);
  const authenticator = quoteIdent(authenticatorRole);
  return `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${anchorLiteral}) THEN
        CREATE ROLE ${anchor} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF;
    END
    $$;
    GRANT ${anchor} TO ${authenticator} WITH INHERIT FALSE, SET FALSE;
    GRANT ${anchor} TO ${user} WITH INHERIT FALSE, SET FALSE;
  `;
}

export function renderTenantHbaPairingDropSql(
  dbName: string,
  dbUser: string,
  authenticatorRole: string,
): string {
  assertValidDbName("dbName", dbName);
  assertValidIdentifier("dbUser", dbUser);
  assertValidIdentifier("authenticatorRole", authenticatorRole);
  const anchorLiteral = quoteLiteral(dbName);
  const userLiteral = quoteLiteral(dbUser);
  const authenticatorLiteral = quoteLiteral(authenticatorRole);
  return `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${anchorLiteral}) THEN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${authenticatorLiteral}) THEN
          EXECUTE format('REVOKE %I FROM %I', ${anchorLiteral}, ${authenticatorLiteral});
        END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${userLiteral}) THEN
          EXECUTE format('REVOKE %I FROM %I', ${anchorLiteral}, ${userLiteral});
        END IF;
        EXECUTE format('DROP ROLE %I', ${anchorLiteral});
      END IF;
    END
    $$;
  `;
}
