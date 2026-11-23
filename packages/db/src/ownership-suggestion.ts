/**
 * Deterministic, explainable ownership assistance.
 *
 * This is a pure read over declarations that already exist in database modules:
 * explicit `operationOwnership` entries and client-role grants. It never looks at
 * table names, never writes a manifest and never opens a database connection.
 */

import {
  TABLE_OPERATIONS,
  type DatabaseModule,
  type GrantDecl,
  type OperationOwner,
  type TableOperation,
} from './module.js';

/** Roles whose grants expose a table operation to the public Data API. */
export const CLIENT_DATA_API_ROLES = ['anon', 'authenticated'] as const;
/** Owners that a direct client write grant cannot distinguish between. */
export const WRITE_GRANT_CANDIDATES = ['durable-command', 'postgrest-data-api'] as const;

export type OwnershipStatus = 'declared' | 'suggested' | 'ambiguous' | 'unknown';
export type OwnershipConfidence = 'explicit' | 'high' | 'ambiguous' | 'unknown';
export type OwnershipReason =
  | 'explicit-declaration'
  | 'conflicting-declarations'
  | 'client-select-grant'
  | 'write-grant-ambiguous'
  | 'no-evidence';

export interface OwnershipEvidence {
  kind: 'declaration' | 'grant' | 'missing-grant';
  /** Human-readable, stable explanation. */
  detail: string;
  /** Grant evidence only. */
  role?: string;
  privilege?: string;
  source?: string;
}

export interface OperationOwnershipSuggestion {
  /** Schema-qualified table name. */
  table: string;
  operation: TableOperation;
  status: OwnershipStatus;
  /** Selected owner; null when evidence is ambiguous or missing. */
  owner: OperationOwner | null;
  /** Possible owners for ambiguous evidence, sorted by name. */
  candidates: OperationOwner[];
  confidence: OwnershipConfidence;
  reason: OwnershipReason;
  evidence: OwnershipEvidence[];
}

const CLIENT_ROLES: ReadonlySet<string> = new Set(CLIENT_DATA_API_ROLES);
const WRITE_OPERATIONS: ReadonlySet<TableOperation> = new Set(['insert', 'update', 'delete']);

function privilegeMatches(privilege: string, operation: TableOperation): boolean {
  const normalized = privilege.trim().toUpperCase();
  return normalized === 'ALL' || normalized === operation.toUpperCase();
}

function matchingGrants(module: DatabaseModule, table: string, operation: TableOperation): GrantDecl[] {
  return module.grants.filter((grant) =>
    grant.object === table
    && CLIENT_ROLES.has(grant.role.trim().toLowerCase())
    && privilegeMatches(grant.privilege, operation));
}

function grantEvidence(grant: GrantDecl): OwnershipEvidence {
  const role = grant.role.trim().toLowerCase();
  const privilege = grant.privilege.trim().toUpperCase();
  return {
    kind: 'grant',
    detail: `GRANT ${privilege} ON ${grant.object} TO ${role} (${grant.source})`,
    role,
    privilege,
    source: grant.source,
  };
}

function compareEvidence(left: OwnershipEvidence, right: OwnershipEvidence): number {
  return left.detail.localeCompare(right.detail);
}

function declarationEvidence(module: DatabaseModule, table: string, operation: TableOperation, owner: OperationOwner): OwnershipEvidence {
  return {
    kind: 'declaration',
    detail: `operationOwnership: ${table}.${operation} = ${owner} (module ${module.name})`,
  };
}

interface DeclarationSummary {
  owners: Set<OperationOwner>;
  evidence: OwnershipEvidence[];
}

function collectDeclarations(modules: readonly DatabaseModule[]): Map<string, DeclarationSummary> {
  const declarations = new Map<string, DeclarationSummary>();
  for (const module of modules) {
    for (const declaration of module.operationOwnership ?? []) {
      const key = `${declaration.table}.${declaration.operation}`;
      const summary = declarations.get(key) ?? { owners: new Set<OperationOwner>(), evidence: [] };
      summary.owners.add(declaration.owner);
      summary.evidence.push(declarationEvidence(module, declaration.table, declaration.operation, declaration.owner));
      declarations.set(key, summary);
    }
  }
  for (const summary of declarations.values()) summary.evidence.sort(compareEvidence);
  return declarations;
}

function declaredTables(modules: readonly DatabaseModule[]): string[] {
  const tables = new Set<string>();
  for (const module of modules) for (const table of module.tables) tables.add(table);
  return [...tables].sort((left, right) => left.localeCompare(right));
}

function suggestOne(
  modules: readonly DatabaseModule[],
  declarations: Map<string, DeclarationSummary>,
  table: string,
  operation: TableOperation,
): OperationOwnershipSuggestion {
  const declaration = declarations.get(`${table}.${operation}`);
  if (declaration !== undefined) {
    const owners = [...declaration.owners].sort((left, right) => left.localeCompare(right));
    if (owners.length > 1) {
      return {
        table, operation, status: 'ambiguous', owner: null, candidates: owners,
        confidence: 'ambiguous', reason: 'conflicting-declarations', evidence: declaration.evidence,
      };
    }
    return {
      table, operation, status: 'declared', owner: owners[0] ?? null, candidates: [],
      confidence: 'explicit', reason: 'explicit-declaration', evidence: declaration.evidence,
    };
  }

  const grants = modules.flatMap((module) => matchingGrants(module, table, operation))
    .map(grantEvidence)
    .sort(compareEvidence);
  if (grants.length === 0) {
    return {
      table, operation, status: 'unknown', owner: null, candidates: [],
      confidence: 'unknown', reason: 'no-evidence',
      evidence: [{
        kind: 'missing-grant',
        detail: `No anon/authenticated grant found for ${table} ${operation.toUpperCase()}`,
      }],
    };
  }
  if (WRITE_OPERATIONS.has(operation)) {
    // A direct client write grant proves exposure, not intent: it could stay on the
    // Data API or move behind the durable Command. The assist layer must not choose.
    return {
      table, operation, status: 'ambiguous', owner: null,
      candidates: [...WRITE_GRANT_CANDIDATES].sort((left, right) => left.localeCompare(right)),
      confidence: 'ambiguous', reason: 'write-grant-ambiguous', evidence: grants,
    };
  }
  return {
    table, operation, status: 'suggested', owner: 'postgrest-data-api', candidates: [],
    confidence: 'high', reason: 'client-select-grant', evidence: grants,
  };
}

/**
 * Suggests one owner per declared table operation. Explicit declarations win;
 * otherwise client grants provide deterministic evidence. Anything else stays
 * unknown or ambiguous rather than being guessed from the table name.
 */
export function suggestOperationOwnership(
  modules: readonly DatabaseModule[],
): OperationOwnershipSuggestion[] {
  const declarations = collectDeclarations(modules);
  const tables = declaredTables(modules);
  const suggestions: OperationOwnershipSuggestion[] = [];
  for (const table of tables) {
    for (const operation of TABLE_OPERATIONS) {
      suggestions.push(suggestOne(modules, declarations, table, operation));
    }
  }
  return suggestions;
}
