import type { SQL } from "bun";
import { sql } from "../db";
import { encryptSecretIfNeeded, decryptSecretIfNeeded } from "../utils/secret-crypto";
import { ValidationError } from "../utils/errors";

export const CONTROL_SECRET_SCOPES = ["captcha", "connector", "auth-hook"] as const;
export type ControlSecretScope = (typeof CONTROL_SECRET_SCOPES)[number];
export type ManagedControlSecretScope = ControlSecretScope | "webhook";

const MASKED_VALUE = "********";
const SECRET_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

export type ControlSecretStatus = {
  scope: ControlSecretScope;
  name: string;
  configured: boolean;
  value: string;
  updated_at: string | null;
};

export class ControlSecretUnavailableError extends Error {
  constructor(scope: ControlSecretScope, name: string, projectRef: string) {
    super(`Missing managed ${scope} secret "${name}" for project ${projectRef}`);
    this.name = "ControlSecretUnavailableError";
  }
}

function assertScope(scope: string): asserts scope is ControlSecretScope {
  if (!(CONTROL_SECRET_SCOPES as readonly string[]).includes(scope)) {
    throw new ValidationError(`Unsupported control secret scope: ${scope}`);
  }
}

function assertManagedScope(scope: string): asserts scope is ManagedControlSecretScope {
  if (!(CONTROL_SECRET_SCOPES as readonly string[]).includes(scope) && scope !== "webhook") {
    throw new ValidationError(`Unsupported managed secret scope: ${scope}`);
  }
}

function assertName(name: string): void {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new ValidationError("Secret name must start with a lowercase letter and contain only lowercase letters, numbers, dot, dash, or underscore");
  }
}

function statusFromRow(scope: ControlSecretScope, name: string, row?: Record<string, unknown>): ControlSecretStatus {
  return {
    scope,
    name,
    configured: Boolean(row),
    value: MASKED_VALUE,
    updated_at: row?.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
  };
}

type ManagedSecretKey = {
  projectRef: string;
  scope: ManagedControlSecretScope;
  name: string;
};

type ManagedSecretWrite = ManagedSecretKey & { secretValue: string };

export async function storeManagedControlSecret(database: SQL, input: ManagedSecretWrite): Promise<void> {
  assertManagedScope(input.scope);
  assertName(input.name);
  if (!input.secretValue) throw new ValidationError("Secret value must not be empty");
  await database`
    INSERT INTO project_control_secrets (project_ref, scope, name, value_encrypted)
    VALUES (${input.projectRef}, ${input.scope}, ${input.name}, ${encryptSecretIfNeeded(input.secretValue)})
    ON CONFLICT (project_ref, scope, name)
    DO UPDATE SET value_encrypted = EXCLUDED.value_encrypted, updated_at = NOW()
  `;
}

export async function removeManagedControlSecret(database: SQL, input: ManagedSecretKey): Promise<void> {
  assertManagedScope(input.scope);
  assertName(input.name);
  await database`
    DELETE FROM project_control_secrets
    WHERE project_ref = ${input.projectRef} AND scope = ${input.scope} AND name = ${input.name}
  `;
}

export async function readManagedControlSecret(database: SQL, input: ManagedSecretKey): Promise<string | null> {
  assertManagedScope(input.scope);
  assertName(input.name);
  const [secretRow] = await database`
    SELECT value_encrypted
    FROM project_control_secrets
    WHERE project_ref = ${input.projectRef} AND scope = ${input.scope} AND name = ${input.name}
    LIMIT 1
  ` as Array<Record<string, unknown>>;
  return typeof secretRow?.value_encrypted === "string"
    ? decryptSecretIfNeeded(secretRow.value_encrypted)
    : null;
}

export const projectControlSecretsService = {
  mask: MASKED_VALUE,

  async getStatus(projectRef: string, scope: string, name: string): Promise<ControlSecretStatus> {
    assertScope(scope);
    assertName(name);
    const [row] = await sql`
      SELECT updated_at
      FROM project_control_secrets
      WHERE project_ref = ${projectRef} AND scope = ${scope} AND name = ${name}
      LIMIT 1
    ` as Array<Record<string, unknown>>;
    return statusFromRow(scope, name, row);
  },

  async listStatuses(projectRef: string, scope: string): Promise<ControlSecretStatus[]> {
    assertScope(scope);
    const rows = await sql`
      SELECT name, updated_at
      FROM project_control_secrets
      WHERE project_ref = ${projectRef} AND scope = ${scope}
      ORDER BY name
    ` as Array<Record<string, unknown>>;
    return rows.map((row) => statusFromRow(scope, String(row.name), row));
  },

  async upsert(projectRef: string, scope: string, name: string, value: string): Promise<ControlSecretStatus> {
    assertScope(scope);
    await storeManagedControlSecret(sql, { projectRef, scope, name, secretValue: value });
    return this.getStatus(projectRef, scope, name);
  },

  async remove(projectRef: string, scope: string, name: string): Promise<ControlSecretStatus> {
    assertScope(scope);
    await removeManagedControlSecret(sql, { projectRef, scope, name });
    return statusFromRow(scope, name);
  },

  /** Internal runtime-only read. Never expose this value from an HTTP route. */
  async readValue(projectRef: string, scope: string, name: string): Promise<string | null> {
    assertScope(scope);
    return readManagedControlSecret(sql, { projectRef, scope, name });
  },

  async readRequiredValue(projectRef: string, scope: string, name: string): Promise<string> {
    assertScope(scope);
    assertName(name);
    const value = await this.readValue(projectRef, scope, name);
    if (!value) throw new ControlSecretUnavailableError(scope, name, projectRef);
    return value;
  },
};

export function isControlSecretScope(value: string): value is ControlSecretScope {
  return (CONTROL_SECRET_SCOPES as readonly string[]).includes(value);
}
