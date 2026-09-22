declare const brand: unique symbol;

type Branded<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Branded<string, "TenantId">;
export type ActorId = Branded<string, "ActorId">;
export type UserId = Branded<string, "UserId">;
export type ProjectRef = Branded<string, "ProjectRef">;
export type OperationId = Branded<string, "OperationId">;
export type CommandName = Branded<string, "CommandName">;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const PROJECT_REF_PATTERN = /^[a-z0-9-]{1,20}$/u;

function branded<T extends string>(value: string, pattern: RegExp, label: string): T {
  if (!pattern.test(value)) throw new TypeError(`Invalid ${label}`);
  return value as T;
}

export function tenantId(value: string): TenantId {
  return branded<TenantId>(value, IDENTIFIER_PATTERN, "tenant ID");
}

export function actorId(value: string): ActorId {
  return branded<ActorId>(value, IDENTIFIER_PATTERN, "actor ID");
}

export function userId(value: string): UserId {
  return branded<UserId>(value, IDENTIFIER_PATTERN, "user ID");
}

export function projectRef(value: string): ProjectRef {
  return branded<ProjectRef>(value, PROJECT_REF_PATTERN, "project ref");
}

export function operationId(value: string): OperationId {
  return branded<OperationId>(value, IDENTIFIER_PATTERN, "operation ID");
}

export function commandName(value: string): CommandName {
  return branded<CommandName>(value, IDENTIFIER_PATTERN, "command name");
}

export function isTenantId(value: unknown): value is TenantId {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

export function isActorId(value: unknown): value is ActorId {
  return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

export function isProjectRef(value: unknown): value is ProjectRef {
  return typeof value === "string" && PROJECT_REF_PATTERN.test(value);
}
