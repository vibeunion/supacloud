import type { SQL } from "bun";
import { normalizeRpcSchemas } from "./database-governance-input";

export type RpcKind = "command" | "query" | "internal";
export type RpcVolatility = "VOLATILE" | "STABLE" | "IMMUTABLE";
export type RpcSecurity = "DEFINER" | "INVOKER";

export interface RpcCatalogEntry {
  schema_name: string;
  function_name: string;
  identity_args: string;
  arguments_display: string;
  return_type: string;
  language: string;
  volatility: RpcVolatility;
  security: RpcSecurity;
  search_path: string | null;
  comment: string | null;
  smart_tags: Record<string, string | boolean>;
  inferred_kind: RpcKind;
  is_strict: boolean;
}

export function parseSmartTags(comment: string | null | undefined): Record<string, string | boolean> {
  if (!comment) return {};
  const tags: Record<string, string | boolean> = {};
  const regex = /^\s*@([a-zA-Z0-9_]+)(?:[ \t]+([^\n\r]+))?\s*$/gm;
  let match;
  while ((match = regex.exec(comment)) !== null) {
    const key = match[1];
    const rawVal = match[2]?.trim();
    tags[key] = rawVal !== undefined && rawVal.length > 0 ? rawVal : true;
  }
  return tags;
}

export function inferRpcKind(
  name: string,
  volatility: RpcVolatility,
  returnType: string,
  smartTags: Record<string, string | boolean>,
): RpcKind {
  const explicitApi = typeof smartTags.api === "string" ? smartTags.api.toLowerCase() : undefined;
  if (explicitApi === "command" || explicitApi === "mutation") return "command";
  if (explicitApi === "query") return "query";
  if (explicitApi === "internal" || explicitApi === "ignore" || smartTags.internal) return "internal";

  const lowerName = name.toLowerCase();

  const commandPrefixes = [
    "create_", "update_", "delete_", "upsert_", "approve_", "reject_",
    "cancel_", "submit_", "process_", "apply_", "push_", "sync_", "set_",
    "add_", "remove_", "assign_", "reconcile_", "complete_", "lock_", "unlock_",
  ];
  if (commandPrefixes.some((prefix) => lowerName.startsWith(prefix))) {
    return "command";
  }

  const queryPrefixes = [
    "get_", "list_", "find_", "search_", "fetch_", "read_", "count_",
    "check_", "is_", "has_", "validate_", "calculate_",
  ];
  if (queryPrefixes.some((prefix) => lowerName.startsWith(prefix))) {
    return "query";
  }

  if (volatility === "STABLE" || volatility === "IMMUTABLE") {
    return "query";
  }

  const lowerReturnType = returnType.toLowerCase();
  if (lowerReturnType === "void" || lowerReturnType === "boolean" || lowerReturnType.includes("receipt")) {
    return "command";
  }

  return "command";
}

export async function readRpcCatalog(
  projectDb: SQL,
  schemas = ["public", "api"],
): Promise<RpcCatalogEntry[]> {
  const normalizedSchemas = normalizeRpcSchemas(schemas);
  const schemaList = normalizedSchemas.map((s) => `'${s.replaceAll("'", "''")}'`).join(", ");
  if (!schemaList) return [];

  const rows = await projectDb.unsafe(`
    SELECT
      n.nspname AS schema_name,
      p.proname AS function_name,
      pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_args,
      pg_catalog.pg_get_function_arguments(p.oid) AS arguments_display,
      pg_catalog.pg_get_function_result(p.oid) AS return_type,
      l.lanname AS language,
      p.provolatile AS volatility_char,
      p.prosecdef AS security_definer,
      p.proisstrict AS is_strict,
      p.proconfig AS config,
      pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_language l ON l.oid = p.prolang
    WHERE p.prokind = 'f'
      AND n.nspname IN (${schemaList})
    ORDER BY n.nspname, p.proname;
  `);

  return (rows as Array<Record<string, unknown>>).map((row) => {
    const schema = String(row.schema_name);
    const funcName = String(row.function_name);
    const identityArgs = String(row.identity_args || "");
    const argumentsDisplay = String(row.arguments_display || "");
    const returnType = String(row.return_type || "void");
    const language = String(row.language);
    const isStrict = row.is_strict === true;
    const isSecDef = row.security_definer === true;
    const volatilityChar = String(row.volatility_char || "v");
    const volatility: RpcVolatility = volatilityChar === "i"
      ? "IMMUTABLE"
      : volatilityChar === "s"
        ? "STABLE"
        : "VOLATILE";
    const security: RpcSecurity = isSecDef ? "DEFINER" : "INVOKER";

    const configArray = Array.isArray(row.config) ? (row.config as string[]) : [];
    const searchPathConfig = configArray.find((cfg) => cfg.startsWith("search_path="));
    const searchPath = searchPathConfig ? searchPathConfig.slice("search_path=".length) : null;

    const comment = row.comment ? String(row.comment) : null;
    const smartTags = parseSmartTags(comment);
    const inferredKind = inferRpcKind(funcName, volatility, returnType, smartTags);

    return {
      schema_name: schema,
      function_name: funcName,
      identity_args: identityArgs,
      arguments_display: argumentsDisplay,
      return_type: returnType,
      language,
      volatility,
      security,
      search_path: searchPath,
      comment,
      smart_tags: smartTags,
      inferred_kind: inferredKind,
      is_strict: isStrict,
    };
  });
}
