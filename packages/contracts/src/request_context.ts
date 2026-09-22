import type { ActorId, TenantId, UserId } from "./identity.js";

export type AnonymousActorContext = {
  readonly kind: "anonymous";
  readonly tenantId?: undefined;
  readonly actorId?: undefined;
};

export type UserActorContext = {
  readonly kind: "user";
  readonly tenantId: TenantId;
  readonly actorId: ActorId;
  readonly userId: UserId;
};

export type ServiceActorContext = {
  readonly kind: "service";
  readonly tenantId: TenantId;
  readonly actorId: ActorId;
  readonly service: string;
  readonly scopes: readonly string[];
};

export type ActorContext = AnonymousActorContext | UserActorContext | ServiceActorContext;

export function isAuthenticatedActor(
  context: ActorContext,
): context is UserActorContext | ServiceActorContext {
  return context.kind !== "anonymous";
}

export function requiresTenant(context: ActorContext): TenantId {
  if (!isAuthenticatedActor(context)) throw new TypeError("Authenticated tenant context required");
  return context.tenantId;
}
