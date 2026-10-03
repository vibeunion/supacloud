import { parse, type Node, type TypeName } from "libpg-query";

export interface RpcParameter { name: string; sqlType: string; optional: boolean }
export interface RpcSourceContract {
  name: string;
  identity: string;
  parameters: RpcParameter[];
  returnType: string;
  callable: boolean;
}

function names(nodes: Node[] = []): string[] {
  return nodes.map(node => {
    if (!("String" in node) || typeof node.String.sval !== "string") throw new Error("Invalid SQL identifier");
    return node.String.sval;
  });
}

function typeName(type: TypeName | undefined): string {
  if (!type?.names?.length) throw new Error("Missing SQL type");
  const parts = names(type.names);
  if (parts[0] === "pg_catalog") parts.shift();
  const aliases: Record<string, string> = {
    int2: "smallint", int4: "integer", int8: "bigint", bool: "boolean",
    float4: "real", float8: "double precision", varchar: "character varying",
    timestamptz: "timestamp with time zone", timestamp: "timestamp without time zone",
    timetz: "time with time zone", time: "time without time zone",
  };
  const value = parts.join(".");
  return `${type.setof ? "SETOF " : ""}${aliases[value] ?? value}${type.arrayBounds?.length ? "[]" : ""}`;
}

function qualified(nodes: Node[] | undefined): string {
  const parts = names(nodes);
  // Fail closed rather than emitting ambiguous identities for quoted dotted names.
  if (parts.length !== 2 || parts.some(part => !/^[a-z_][a-z0-9_$]*$/.test(part))) {
    throw new Error("Use an explicit lowercase schema-qualified function name");
  }
  return parts.join(".");
}

/** Tracks explicit top-level DDL only; dynamic SQL and deployed parity need catalog verification. */
export async function migrationFunctionIdentities(sources: readonly string[]): Promise<Set<string>> {
  const identities = new Set<string>();
  const targetIdentity = (node: Node): string => {
    if (!("ObjectWithArgs" in node) || node.ObjectWithArgs.args_unspecified) throw new Error("Migration function changes require an explicit signature");
    const target = node.ObjectWithArgs;
    const types = (target.objargs ?? []).map(argument => {
      if (!("TypeName" in argument)) throw new Error("Invalid migration function type");
      return typeName(argument.TypeName);
    });
    return `${qualified(target.objname)}(${types.join(", ")})`;
  };
  for (const source of sources) {
    for (const { stmt } of (await parse(source)).stmts ?? []) {
      if (!stmt) continue;
      if ("CreateFunctionStmt" in stmt && !stmt.CreateFunctionStmt.is_procedure) {
        const fn = stmt.CreateFunctionStmt;
        const types = (fn.parameters ?? []).flatMap(node => {
          if (!("FunctionParameter" in node)) throw new Error("Invalid migration parameter");
          return ["FUNC_PARAM_OUT", "FUNC_PARAM_TABLE"].includes(node.FunctionParameter.mode ?? "")
            ? [] : [typeName(node.FunctionParameter.argType)];
        });
        identities.add(`${qualified(fn.funcname)}(${types.join(", ")})`);
      } else if ("DropStmt" in stmt && stmt.DropStmt.removeType === "OBJECT_FUNCTION") {
        for (const target of stmt.DropStmt.objects ?? []) identities.delete(targetIdentity(target));
      } else if ("RenameStmt" in stmt && stmt.RenameStmt.renameType === "OBJECT_FUNCTION") {
        const rename = stmt.RenameStmt;
        if (!rename.object || !rename.newname || !/^[a-z_][a-z0-9_$]*$/.test(rename.newname)) throw new Error("Invalid function rename");
        const old = targetIdentity(rename.object);
        identities.delete(old);
        const schema = old.slice(0, old.indexOf("."));
        identities.add(`${schema}.${rename.newname}${old.slice(old.indexOf("("))}`);
      }
    }
  }
  return identities;
}

/** Source declarations, never an assertion about role inheritance or a deployed database. */
export async function rpcSourceContract(sql: string, role: string): Promise<RpcSourceContract> {
  const statements = (await parse(sql)).stmts ?? [];
  const functions = statements.flatMap(({ stmt }) => stmt && "CreateFunctionStmt" in stmt ? [stmt.CreateFunctionStmt] : []);
  const fn = functions[0];
  if (functions.length !== 1 || !fn || fn.is_procedure) throw new Error("Each source must declare exactly one function");
  const name = qualified(fn.funcname);
  const parameters: RpcParameter[] = [];
  let tableResult = false, unnamed = false;
  for (const node of fn.parameters ?? []) {
    if (!("FunctionParameter" in node)) throw new Error("Invalid function parameter");
    const parameter = node.FunctionParameter;
    if (["FUNC_PARAM_OUT", "FUNC_PARAM_TABLE"].includes(parameter.mode ?? "")) {
      tableResult = true;
      continue;
    }
    if (parameter.mode === "FUNC_PARAM_VARIADIC") throw new Error("Variadic RPC contracts require a reviewed adapter");
    if (parameter.mode === "FUNC_PARAM_INOUT") tableResult = true;
    unnamed ||= !parameter.name;
    parameters.push({ name: parameter.name ?? "", sqlType: typeName(parameter.argType), optional: parameter.defexpr !== undefined });
  }
  const identity = `${name}(${parameters.map(parameter => parameter.sqlType).join(", ")})`;
  let publicGrant: boolean | undefined;
  let directGrant = false;
  for (const { stmt } of statements) {
    if (!stmt) throw new Error("Missing SQL statement");
    if ("CreateFunctionStmt" in stmt) continue;
    if (!("GrantStmt" in stmt)) throw new Error("Function sources may contain only a function and its EXECUTE ACL");
    const grant = stmt.GrantStmt;
    if (grant.objtype !== "OBJECT_FUNCTION" || grant.targtype !== "ACL_TARGET_OBJECT") throw new Error("Foreign ACL target");
    if (grant.privileges?.some(privilege => !("AccessPriv" in privilege) || privilege.AccessPriv.priv_name !== "execute")) {
      throw new Error("Only EXECUTE function privileges are supported");
    }
    for (const target of grant.objects ?? []) {
      if (!("ObjectWithArgs" in target) || target.ObjectWithArgs.args_unspecified) throw new Error("Explicit ACL signature required");
      const object = target.ObjectWithArgs;
      const types = (object.objargs ?? []).map(argument => {
        if (!("TypeName" in argument)) throw new Error("Invalid ACL argument");
        return typeName(argument.TypeName);
      });
      if (`${qualified(object.objname)}(${types.join(", ")})` !== identity) throw new Error("ACL does not belong to this function");
    }
    if (!grant.is_grant && grant.grant_option) continue;
    for (const node of grant.grantees ?? []) {
      if (!("RoleSpec" in node)) throw new Error("Invalid ACL role");
      if (node.RoleSpec.roletype === "ROLESPEC_PUBLIC") publicGrant = grant.is_grant === true;
      if (node.RoleSpec.rolename === role) directGrant = grant.is_grant === true;
    }
  }
  const returns = tableResult ? "record" : typeName(fn.returnType);
  const internal = unnamed || ["trigger", "event_trigger"].includes(returns);
  if (!internal && publicGrant === undefined) throw new Error(`Explicit PUBLIC EXECUTE grant/revocation required: ${identity}`);
  return { name, identity, parameters, returnType: returns, callable: !internal && (publicGrant === true || directGrant) };
}

function tsType(sqlType: string): string {
  if (sqlType.startsWith("SETOF ")) return `Array<${tsType(sqlType.slice(6))} | null>`;
  if (sqlType.endsWith("[]")) return `Array<${tsType(sqlType.slice(0, -2))} | null>`;
  if (["bigint", "numeric", "decimal"].includes(sqlType)) return "number | string";
  if (["smallint", "integer", "real", "double precision"].includes(sqlType)) return "number";
  if (sqlType === "boolean") return "boolean";
  if (sqlType === "void") return "void";
  if (["text", "uuid", "character varying", "character", "date", "interval",
    "timestamp with time zone", "timestamp without time zone", "time with time zone", "time without time zone"].includes(sqlType)) return "string";
  return "unknown";
}

export function renderRpcSourceTypes(contracts: readonly RpcSourceContract[]): string {
  const groups = new Map<string, RpcSourceContract[]>();
  for (const contract of contracts.filter(item => item.callable)) {
    groups.set(contract.name, [...(groups.get(contract.name) ?? []), contract]);
  }
  const lines = [
    "// Generated by supacloud-db. Source contracts only; decode untrusted responses.",
    "export interface RpcDefinitions {",
  ];
  for (const [name, overloads] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const shapes = overloads.map(overload => {
      const args = overload.parameters.length
        ? `{ ${overload.parameters.map(parameter => `${JSON.stringify(parameter.name)}${parameter.optional ? "?" : ""}: ${tsType(parameter.sqlType)} | null`).join("; ")} }`
        : "Record<string, never>";
      return `{ args: ${args}; result: ${tsType(overload.returnType)} | null }`;
    });
    lines.push(`  ${JSON.stringify(name)}: ${shapes.join(" | ")};`);
  }
  lines.push("}", "export type RpcName = keyof RpcDefinitions;",
    'export type RpcArgs<Name extends RpcName> = RpcDefinitions[Name]["args"];',
    'export type RpcResult<Name extends RpcName> = RpcDefinitions[Name]["result"];', "");
  return lines.join("\n");
}
