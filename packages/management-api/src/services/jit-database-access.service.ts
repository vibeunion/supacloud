import { createHash, randomBytes, randomUUID } from "node:crypto";
import { config } from "../config";
import { getProjectDb, resolveDbName, sql } from "../db";
import { logger } from "../utils/logger";
import {
  JitDatabaseGateway,
  normalizeAllowedNetworks,
  normalizeGatewayPortRange,
  serializeAllowedNetworks,
  type NormalizedAllowedNetworks,
} from "./jit-database-gateway.service";

export type JitAccessState = "enabled" | "disabled";

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const FORBIDDEN_ROLES = new Set([
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_realtime_admin",
  "supabase_storage_admin",
  "authenticator",
]);
const MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 5 * 60 * 1000;
const MAX_ACTIVE_CREDENTIALS_PER_USER = 5;
const MAX_ACTIVE_CREDENTIALS_PER_PROJECT = 100;
const MAX_ISSUED_CREDENTIALS_PER_USER_HOUR = 10;
const MAX_ISSUED_CREDENTIALS_PER_PROJECT_HOUR = 100;
const gatewayPortRange = normalizeGatewayPortRange(config.jitDatabaseGatewayPortRange);
export const jitDatabaseGateway = new JitDatabaseGateway(
  config.jitDatabaseGatewayBindHost,
  config.pgHost,
  config.pgPort,
);
let schemaReady: Promise<void> | null = null;

export class JitDatabaseAccessError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "jit_access_error") {
    super(message);
    this.name = "JitDatabaseAccessError";
  }
}

export function normalizeJitRole(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new JitDatabaseAccessError("role must be a PostgreSQL identifier");
  }
  if (value.startsWith("jit_") || FORBIDDEN_ROLES.has(value)) {
    throw new JitDatabaseAccessError("role cannot be a managed service role");
  }
  return value;
}

export function normalizeJitExpiry(value: unknown, now = Date.now()): Date {
  const timestamp = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= now) {
    throw new JitDatabaseAccessError("expires_at must be a future Unix timestamp in milliseconds");
  }
  if (timestamp - now < MIN_TTL_MS) {
    throw new JitDatabaseAccessError("expires_at must be at least 5 minutes in the future");
  }
  if (timestamp - now > MAX_TTL_MS) {
    throw new JitDatabaseAccessError("expires_at must not exceed 90 days");
  }
  return new Date(timestamp);
}

export function buildJitLoginRole(ref: string, userId: string, role: string, credentialId: string): string {
  const digest = createHash("sha256").update(`${ref}\0${userId}\0${role}\0${credentialId}`).digest("hex").slice(0, 40);
  return `jit_${digest}`;
}

export type JitTargetRoleInfo = {
  rolname: string;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  inheritsPrivilegedRole: boolean;
};

export function isJitTargetRoleAllowed(role: JitTargetRoleInfo): boolean {
  if (!IDENTIFIER_PATTERN.test(role.rolname)) return false;
  if (role.rolname === "postgres" || role.rolname.startsWith("pg_")) return false;
  return !role.rolsuper
    && !role.rolcreaterole
    && !role.rolcreatedb
    && !role.rolreplication
    && !role.rolbypassrls
    && !role.inheritsPrivilegedRole;
}

export function assertJitCredentialCapacity(userActive: number, projectActive: number): void {
  if (userActive >= MAX_ACTIVE_CREDENTIALS_PER_USER) {
    throw new JitDatabaseAccessError(
      `A user may have at most ${MAX_ACTIVE_CREDENTIALS_PER_USER} active temporary credentials per project`,
      429,
      "jit_user_credential_capacity",
    );
  }
  if (projectActive >= MAX_ACTIVE_CREDENTIALS_PER_PROJECT) {
    throw new JitDatabaseAccessError(
      `A project may have at most ${MAX_ACTIVE_CREDENTIALS_PER_PROJECT} active temporary credentials`,
      429,
      "jit_project_credential_capacity",
    );
  }
}

export function assertJitIssuanceRate(userIssued: number, projectIssued: number): void {
  if (userIssued >= MAX_ISSUED_CREDENTIALS_PER_USER_HOUR) {
    throw new JitDatabaseAccessError(
      `A user may issue at most ${MAX_ISSUED_CREDENTIALS_PER_USER_HOUR} temporary credentials per hour`,
      429,
      "jit_user_issuance_rate",
    );
  }
  if (projectIssued >= MAX_ISSUED_CREDENTIALS_PER_PROJECT_HOUR) {
    throw new JitDatabaseAccessError(
      `A project may issue at most ${MAX_ISSUED_CREDENTIALS_PER_PROJECT_HOUR} temporary credentials per hour`,
      429,
      "jit_project_issuance_rate",
    );
  }
}

export function jitRuleCoversCredential(
  credential: { expiresAt: Date; allowedNetworks: NormalizedAllowedNetworks },
  rule: { expiresAt: Date; allowedNetworks: NormalizedAllowedNetworks } | null,
): boolean {
  if (!rule || credential.expiresAt.getTime() > rule.expiresAt.getTime()) return false;
  return JSON.stringify(serializeAllowedNetworks(credential.allowedNetworks))
    === JSON.stringify(serializeAllowedNetworks(rule.allowedNetworks));
}

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) throw new JitDatabaseAccessError("Unsafe PostgreSQL identifier");
  return `"${value}"`;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = sql.unsafe(`
      CREATE TABLE IF NOT EXISTS project_jit_access_settings (
        project_ref text PRIMARY KEY REFERENCES projects(ref) ON DELETE CASCADE,
        state text NOT NULL DEFAULT 'disabled' CHECK (state IN ('enabled', 'disabled')),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS project_jit_access_rules (
        project_ref text NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
        user_id text NOT NULL,
        role text NOT NULL,
        allowed_networks jsonb NOT NULL DEFAULT '{}'::jsonb,
        branches_only boolean NOT NULL DEFAULT false,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_ref, user_id, role)
      );
      CREATE TABLE IF NOT EXISTS project_jit_credentials (
        id uuid PRIMARY KEY,
        project_ref text NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
        user_id text NOT NULL,
        target_role text NOT NULL,
        login_role text NOT NULL UNIQUE,
        token_hash text NOT NULL,
        gateway_port integer,
        allowed_networks jsonb NOT NULL DEFAULT '{}'::jsonb,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS project_jit_credentials_active_idx
        ON project_jit_credentials(project_ref, user_id, target_role, expires_at)
        WHERE revoked_at IS NULL;
      ALTER TABLE project_jit_access_rules ADD COLUMN IF NOT EXISTS allowed_networks jsonb NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE project_jit_access_rules ADD COLUMN IF NOT EXISTS branches_only boolean NOT NULL DEFAULT false;
      ALTER TABLE project_jit_credentials ADD COLUMN IF NOT EXISTS gateway_port integer;
      ALTER TABLE project_jit_credentials ADD COLUMN IF NOT EXISTS allowed_networks jsonb NOT NULL DEFAULT '{}'::jsonb;
      CREATE UNIQUE INDEX IF NOT EXISTS project_jit_credentials_active_gateway_port_idx
        ON project_jit_credentials(gateway_port)
        WHERE revoked_at IS NULL AND gateway_port IS NOT NULL;
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function revokeLoginRole(ref: string, loginRole: string): Promise<void> {
  const projectDb = getProjectDb(await resolveDbName(ref));
  const [existing] = await projectDb`SELECT 1 FROM pg_roles WHERE rolname = ${loginRole} LIMIT 1`;
  if (!existing) return;
  // Disable LOGIN before terminating/dropping so a transient DROP failure does
  // not leave a still-valid temporary password usable.
  await projectDb.unsafe(`ALTER ROLE ${quoteIdentifier(loginRole)} NOLOGIN`);
  await projectDb`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ${loginRole} AND pid <> pg_backend_pid()`;
  await projectDb.unsafe(`DROP ROLE IF EXISTS ${quoteIdentifier(loginRole)}`);
}

async function resolveParentProjectRef(ref: string, controlDb: typeof sql = sql): Promise<string | null> {
  const [project] = await controlDb`
    SELECT NULLIF(config->>'parent_ref', '') AS parent_ref
    FROM projects WHERE ref = ${ref} LIMIT 1
  `;
  return project?.parent_ref ? String(project.parent_ref) : null;
}

async function withJitProjectLocks<T>(
  refs: Array<string | null>,
  operation: (tx: typeof sql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (transaction) => {
    const tx = transaction as typeof sql;
    for (const ref of [...new Set(refs.filter((value): value is string => Boolean(value)))].sort()) {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`supacloud-jit:${ref}`}))`;
    }
    return operation(tx);
  });
}

async function readJitState(ref: string, parentRef: string | null, controlDb: typeof sql) {
  const [local] = await controlDb`
    SELECT state, updated_at FROM project_jit_access_settings WHERE project_ref = ${ref}
  `;
  if (local) return { state: local.state as JitAccessState, updated_at: local.updated_at || null, inherited_from: null };
  if (parentRef) {
    const [parent] = await controlDb`
      SELECT state, updated_at FROM project_jit_access_settings WHERE project_ref = ${parentRef}
    `;
    if (parent) return { state: parent.state as JitAccessState, updated_at: parent.updated_at || null, inherited_from: parentRef };
  }
  return { state: "disabled" as JitAccessState, updated_at: null, inherited_from: null };
}

async function readEffectiveJitRule(
  ref: string,
  parentRef: string | null,
  userId: string,
  role: string,
  controlDb: typeof sql,
) {
  let [rule] = await controlDb`
    SELECT expires_at, allowed_networks, branches_only FROM project_jit_access_rules
    WHERE project_ref = ${ref} AND user_id = ${userId} AND role = ${role} AND expires_at > now()
    LIMIT 1
  `;
  if (!rule && parentRef) {
    [rule] = await controlDb`
      SELECT expires_at, allowed_networks, branches_only FROM project_jit_access_rules
      WHERE project_ref = ${parentRef} AND user_id = ${userId} AND role = ${role}
        AND branches_only = true AND expires_at > now()
      LIMIT 1
    `;
  }
  return rule || null;
}

async function assertUserIsActiveCollaborator(ref: string, userId: string): Promise<void> {
  let [collaborator] = await sql`
    SELECT 1 FROM project_collaborators
    WHERE project_ref = ${ref} AND principal_id = ${userId} AND status = 'active'
    LIMIT 1
  `;
  if (!collaborator) {
    const parentRef = await resolveParentProjectRef(ref);
    if (parentRef) {
      [collaborator] = await sql`
        SELECT 1 FROM project_collaborators
        WHERE project_ref = ${parentRef} AND principal_id = ${userId} AND status = 'active'
        LIMIT 1
      `;
    }
  }
  if (!collaborator) throw new JitDatabaseAccessError("user_id is not an active project collaborator", 404, "jit_user_not_found");
}

async function assertTargetRole(ref: string, targetRole: string): Promise<void> {
  const projectDb = getProjectDb(await resolveDbName(ref));
  const [role] = await projectDb`
    WITH RECURSIVE role_memberships(oid) AS (
      SELECT oid FROM pg_roles WHERE rolname = ${targetRole}
      UNION
      SELECT m.roleid FROM pg_auth_members m JOIN role_memberships rm ON rm.oid = m.member
    )
    SELECT target.rolname, target.rolsuper, target.rolcreaterole, target.rolcreatedb,
      target.rolreplication, target.rolbypassrls,
      COALESCE(bool_or(
        inherited.rolname LIKE 'pg_%' OR inherited.rolsuper OR inherited.rolcreaterole
        OR inherited.rolcreatedb OR inherited.rolreplication OR inherited.rolbypassrls
      ), false) AS "inheritsPrivilegedRole"
    FROM pg_roles target
    JOIN role_memberships rm ON true
    JOIN pg_roles inherited ON inherited.oid = rm.oid
    WHERE target.rolname = ${targetRole}
    GROUP BY target.rolname, target.rolsuper, target.rolcreaterole, target.rolcreatedb,
      target.rolreplication, target.rolbypassrls
    LIMIT 1
  `;
  if (!role) throw new JitDatabaseAccessError(`PostgreSQL role '${targetRole}' was not found`, 404, "jit_role_not_found");
  if (!isJitTargetRoleAllowed(role as JitTargetRoleInfo)) {
    throw new JitDatabaseAccessError(`PostgreSQL role '${targetRole}' is not eligible for temporary access`, 403, "jit_role_not_allowed");
  }
}

function parseStoredNetworks(value: unknown): NormalizedAllowedNetworks {
  try {
    return normalizeAllowedNetworks(typeof value === "string" ? JSON.parse(value) : value);
  } catch (error) {
    throw new JitDatabaseAccessError(error instanceof Error ? error.message : "Stored JIT network policy is invalid", 500, "jit_network_policy_invalid");
  }
}

function hasAllowedNetworks(value: NormalizedAllowedNetworks): boolean {
  return value.ipv4.length > 0 || value.ipv6.length > 0;
}

async function allocateGatewayPort(tx: typeof sql): Promise<number> {
  await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext('supacloud-jit-database-gateway-port'))");
  await cleanupExpiredCredentials(tx);
  const usedRows = await tx`
    SELECT gateway_port FROM project_jit_credentials
    WHERE revoked_at IS NULL AND gateway_port IS NOT NULL
  `;
  const used = new Set(usedRows.map((row: { gateway_port: unknown }) => Number(row.gateway_port)));
  for (let port = gatewayPortRange.start; port <= gatewayPortRange.end; port++) {
    if (!used.has(port)) return port;
  }
  throw new JitDatabaseAccessError("No JIT database gateway ports are available", 503, "jit_gateway_capacity");
}

async function cleanupExpiredCredentials(controlDb: typeof sql, projectRef?: string): Promise<void> {
  const expired = await controlDb`
    SELECT id, project_ref, login_role FROM project_jit_credentials
    WHERE revoked_at IS NULL AND expires_at <= now()
      AND (${projectRef ?? null}::text IS NULL OR project_ref = ${projectRef ?? null})
  `;
  for (const credential of expired) {
    jitDatabaseGateway.release(String(credential.id));
    await revokeLoginRole(String(credential.project_ref), String(credential.login_role));
  }
  if (expired.length > 0) {
    await controlDb`
      UPDATE project_jit_credentials SET revoked_at = now()
      WHERE revoked_at IS NULL AND id IN ${controlDb(expired.map((credential: { id: unknown }) => credential.id))}
    `;
  }

  const retired = await controlDb`
    SELECT id, project_ref, login_role FROM project_jit_credentials
    WHERE revoked_at < now() - interval '30 days'
      AND (${projectRef ?? null}::text IS NULL OR project_ref = ${projectRef ?? null})
  `;
  for (const credential of retired) {
    jitDatabaseGateway.release(String(credential.id));
    await revokeLoginRole(String(credential.project_ref), String(credential.login_role));
  }
  if (retired.length > 0) {
    await controlDb`
      DELETE FROM project_jit_credentials
      WHERE id IN ${controlDb(retired.map((credential: { id: unknown }) => credential.id))}
    `;
  }
}

export const jitDatabaseAccessService = {
  async state(ref: string) {
    await ensureSchema();
    const parentRef = await resolveParentProjectRef(ref);
    return readJitState(ref, parentRef, sql);
  },

  async setState(ref: string, state: JitAccessState) {
    await ensureSchema();
    if (state !== "enabled" && state !== "disabled") throw new JitDatabaseAccessError("state must be enabled or disabled");
    return withJitProjectLocks([ref], async (tx) => {
      if (state === "disabled") {
        const active = await tx`
          SELECT id, project_ref, login_role FROM project_jit_credentials
          WHERE revoked_at IS NULL AND (
            project_ref = ${ref}
            OR project_ref IN (
              SELECT child.ref
              FROM projects child
              LEFT JOIN project_jit_access_settings local_state ON local_state.project_ref = child.ref
              WHERE NULLIF(child.config->>'parent_ref', '') = ${ref}
                AND COALESCE(local_state.state, 'disabled') <> 'enabled'
            )
          )
        `;
        for (const credential of active) {
          jitDatabaseGateway.release(String(credential.id));
          await revokeLoginRole(String(credential.project_ref), String(credential.login_role));
        }
        if (active.length > 0) {
          await tx`
            UPDATE project_jit_credentials SET revoked_at = now()
            WHERE revoked_at IS NULL AND id IN ${tx(active.map((credential: { id: unknown }) => credential.id))}
          `;
        }
      }
      const [row] = await tx`
        INSERT INTO project_jit_access_settings (project_ref, state, updated_at)
        VALUES (${ref}, ${state}, now())
        ON CONFLICT (project_ref) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
        RETURNING state, updated_at
      `;
      return row;
    });
  },

  async listRules(ref: string) {
    await ensureSchema();
    const localRows = await sql`
      SELECT user_id, role, allowed_networks, branches_only, (extract(epoch from expires_at) * 1000)::bigint AS expires_at, created_at, updated_at
      FROM project_jit_access_rules WHERE project_ref = ${ref}
      ORDER BY user_id, role
    `;
    const parentRef = await resolveParentProjectRef(ref);
    if (!parentRef) return { user_roles: localRows };
    const inheritedRows = await sql`
      SELECT user_id, role, allowed_networks, branches_only, (extract(epoch from expires_at) * 1000)::bigint AS expires_at, created_at, updated_at
      FROM project_jit_access_rules
      WHERE project_ref = ${parentRef} AND branches_only = true
      ORDER BY user_id, role
    `;
    const byKey = new Map<string, unknown>();
    for (const row of inheritedRows) byKey.set(`${row.user_id}\0${row.role}`, { ...row, inherited_from: parentRef });
    for (const row of localRows) byKey.set(`${row.user_id}\0${row.role}`, row);
    return { user_roles: [...byKey.values()] };
  },

  async replaceRules(ref: string, input: { user_id: string; user_roles: Array<{ role: string; expires_at: number; allowed_networks?: unknown; branches_only?: boolean }> }) {
    await ensureSchema();
    if (!input.user_id || !Array.isArray(input.user_roles) || input.user_roles.length > 32) {
      throw new JitDatabaseAccessError("user_id and up to 32 user_roles are required");
    }
    await assertUserIsActiveCollaborator(ref, input.user_id);
    const normalized = await Promise.all(input.user_roles.map(async (rule) => {
      const role = normalizeJitRole(rule.role);
      await assertTargetRole(ref, role);
      let allowedNetworks: NormalizedAllowedNetworks;
      try {
        allowedNetworks = normalizeAllowedNetworks(rule.allowed_networks);
      } catch (error) {
        throw new JitDatabaseAccessError(error instanceof Error ? error.message : "Invalid allowed_networks");
      }
      return { role, expiresAt: normalizeJitExpiry(rule.expires_at), allowedNetworks, branchesOnly: rule.branches_only === true };
    }));

    const childRows = await sql`
      SELECT ref FROM projects WHERE NULLIF(config->>'parent_ref', '') = ${ref}
    `;
    await withJitProjectLocks(
      [ref, ...childRows.map((row: { ref: unknown }) => String(row.ref))],
      async (tx) => {
      await tx`DELETE FROM project_jit_access_rules WHERE project_ref = ${ref} AND user_id = ${input.user_id}`;
      for (const rule of normalized) {
        await tx`
          INSERT INTO project_jit_access_rules (project_ref, user_id, role, allowed_networks, branches_only, expires_at)
          VALUES (${ref}, ${input.user_id}, ${rule.role}, ${JSON.stringify(serializeAllowedNetworks(rule.allowedNetworks))}::jsonb, ${rule.branchesOnly}, ${rule.expiresAt})
        `;
      }
      const active = await tx`
        SELECT credential.id, credential.project_ref, credential.target_role, credential.login_role,
          credential.allowed_networks, credential.expires_at,
          NULLIF(project.config->>'parent_ref', '') AS parent_ref
        FROM project_jit_credentials credential
        JOIN projects project ON project.ref = credential.project_ref
        WHERE credential.user_id = ${input.user_id}
          AND credential.revoked_at IS NULL
          AND credential.expires_at > now()
          AND (credential.project_ref = ${ref} OR NULLIF(project.config->>'parent_ref', '') = ${ref})
      `;
      const revokedIds: unknown[] = [];
      for (const credential of active) {
        const credentialRef = String(credential.project_ref);
        const effectiveRule = await readEffectiveJitRule(
          credentialRef,
          credential.parent_ref ? String(credential.parent_ref) : null,
          input.user_id,
          String(credential.target_role),
          tx,
        );
        const applicableRule = effectiveRule?.branches_only === true && !credential.parent_ref
          ? null
          : effectiveRule;
        const covered = jitRuleCoversCredential({
          expiresAt: new Date(credential.expires_at as Date),
          allowedNetworks: parseStoredNetworks(credential.allowed_networks),
        }, applicableRule ? {
          expiresAt: new Date(applicableRule.expires_at as Date),
          allowedNetworks: parseStoredNetworks(applicableRule.allowed_networks),
        } : null);
        if (covered) continue;
        jitDatabaseGateway.release(String(credential.id));
        await revokeLoginRole(credentialRef, String(credential.login_role));
        revokedIds.push(credential.id);
      }
      if (revokedIds.length > 0) {
        await tx`
          UPDATE project_jit_credentials SET revoked_at = now()
          WHERE revoked_at IS NULL AND id IN ${tx(revokedIds)}
        `;
      }
    });
    return this.listRules(ref);
  },

  async issueCredential(ref: string, input: { user_id: string; role: string }) {
    await ensureSchema();
    const role = normalizeJitRole(input.role);
    const parentRef = await resolveParentProjectRef(ref);
    return withJitProjectLocks([ref, parentRef], async (tx) => {
      const lockedParentRef = await resolveParentProjectRef(ref, tx);
      const state = await readJitState(ref, lockedParentRef, tx);
      if (state.state !== "enabled") {
        throw new JitDatabaseAccessError("Temporary database access is disabled", 409, "jit_access_disabled");
      }
      const rule = await readEffectiveJitRule(ref, lockedParentRef, input.user_id, role, tx);
      if (!rule) throw new JitDatabaseAccessError("No active temporary access rule matches this user and role", 403, "jit_rule_denied");
      if (rule.branches_only === true && !lockedParentRef) {
        throw new JitDatabaseAccessError("This temporary access rule is restricted to branch projects", 403, "jit_branches_only");
      }
      await assertUserIsActiveCollaborator(ref, input.user_id);
      await assertTargetRole(ref, role);
      await cleanupExpiredCredentials(tx, ref);
      const [capacity] = await tx`
        SELECT count(*)::integer AS project_active,
          count(*) FILTER (WHERE user_id = ${input.user_id})::integer AS user_active
        FROM project_jit_credentials
        WHERE project_ref = ${ref} AND revoked_at IS NULL AND expires_at > now()
      `;
      assertJitCredentialCapacity(Number(capacity?.user_active || 0), Number(capacity?.project_active || 0));
      const [issuance] = await tx`
        SELECT count(*)::integer AS project_issued,
          count(*) FILTER (WHERE user_id = ${input.user_id})::integer AS user_issued
        FROM project_jit_credentials
        WHERE project_ref = ${ref} AND created_at > now() - interval '1 hour'
      `;
      assertJitIssuanceRate(Number(issuance?.user_issued || 0), Number(issuance?.project_issued || 0));

      const credentialId = randomUUID();
      const loginRole = buildJitLoginRole(ref, input.user_id, role, credentialId);
      const token = `supac_jit_${randomBytes(32).toString("base64url")}`;
      const expiresAt = normalizeJitExpiry(rule.expires_at);
      const allowedNetworks = parseStoredNetworks(rule.allowed_networks);
      const gatewayRequired = hasAllowedNetworks(allowedNetworks);
      const projectDb = getProjectDb(await resolveDbName(ref));
      await projectDb.unsafe(
        `CREATE ROLE ${quoteIdentifier(loginRole)} LOGIN NOINHERIT CONNECTION LIMIT 5 PASSWORD '${token.replaceAll("'", "''")}' VALID UNTIL '${expiresAt.toISOString()}'`,
      );
      try {
        await projectDb.unsafe(`GRANT ${quoteIdentifier(role)} TO ${quoteIdentifier(loginRole)}`);
        await projectDb.unsafe(`ALTER ROLE ${quoteIdentifier(loginRole)} SET role = ${quoteIdentifier(role)}`);
        const gatewayPort = gatewayRequired ? await allocateGatewayPort(tx) : null;
        await tx`
          INSERT INTO project_jit_credentials
            (id, project_ref, user_id, target_role, login_role, token_hash, gateway_port, allowed_networks, expires_at)
          VALUES
            (${credentialId}, ${ref}, ${input.user_id}, ${role}, ${loginRole}, ${createHash("sha256").update(token).digest("hex")}, ${gatewayPort}, ${JSON.stringify(serializeAllowedNetworks(allowedNetworks))}::jsonb, ${expiresAt})
        `;
        if (gatewayPort !== null) {
          try {
            jitDatabaseGateway.bind({ credentialId, port: gatewayPort, expiresAt, allowedNetworks });
          } catch (error) {
            throw new JitDatabaseAccessError(
              `JIT database gateway could not bind port ${gatewayPort}: ${error instanceof Error ? error.message : String(error)}`,
              503,
              "jit_gateway_bind_failed",
            );
          }
        }

        const dbName = await resolveDbName(ref);
        const host = gatewayPort === null ? config.pgHost : config.jitDatabaseGatewayPublicHost;
        const port = gatewayPort === null ? config.pgPort : gatewayPort;
        return {
          id: credentialId,
          user_id: input.user_id,
          role,
          login_role: loginRole,
          password: token,
          expires_at: expiresAt.getTime(),
          allowed_networks: serializeAllowedNetworks(allowedNetworks),
          connection_string: `postgresql://${encodeURIComponent(loginRole)}:${encodeURIComponent(token)}@${host}:${port}/${encodeURIComponent(dbName)}?sslmode=require`,
        };
      } catch (error) {
        jitDatabaseGateway.release(credentialId);
        await revokeLoginRole(ref, loginRole).catch(() => undefined);
        throw error;
      }
    });
  },

  async revokeCredential(ref: string, credentialId: string) {
    await ensureSchema();
    const [row] = await sql`
      SELECT login_role FROM project_jit_credentials
      WHERE id = ${credentialId} AND project_ref = ${ref} AND revoked_at IS NULL
      LIMIT 1
    `;
    if (!row) throw new JitDatabaseAccessError("Temporary credential not found", 404, "jit_credential_not_found");
    jitDatabaseGateway.release(credentialId);
    await revokeLoginRole(ref, String(row.login_role));
    await sql`UPDATE project_jit_credentials SET revoked_at = now() WHERE id = ${credentialId}`;
    return { id: credentialId, revoked: true };
  },

  async startGateway() {
    await ensureSchema();
    await sql.begin(async (transaction) => cleanupExpiredCredentials(transaction as typeof sql));
    const active = await sql`
      SELECT id, project_ref, login_role, gateway_port, allowed_networks, expires_at
      FROM project_jit_credentials
      WHERE revoked_at IS NULL AND expires_at > now() AND gateway_port IS NOT NULL
    `;
    let started = 0;
    const errors: string[] = [];
    for (const credential of active) {
      try {
        jitDatabaseGateway.bind({
          credentialId: String(credential.id),
          port: Number(credential.gateway_port),
          expiresAt: new Date(credential.expires_at as Date),
          allowedNetworks: parseStoredNetworks(credential.allowed_networks),
        });
        started += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${credential.id}: ${message}`);
        logger.error("[JitDatabaseGateway] Failed to restore binding", { credentialId: credential.id, error: message });
        jitDatabaseGateway.release(String(credential.id));
        await revokeLoginRole(String(credential.project_ref), String(credential.login_role)).catch(() => undefined);
        await sql`UPDATE project_jit_credentials SET revoked_at = now() WHERE id = ${credential.id}`;
      }
    }
    return { started, errors };
  },

  stopGateway() {
    jitDatabaseGateway.close();
  },
};
