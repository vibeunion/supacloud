import { Elysia, type Context, type InputSchema } from "elysia";
import type { TSchema } from "typebox";
import { toElysiaRouteSchema, type RouteContractSchemas } from "./schema_contract";

/** Read operations exposed by the identity-bound ZenStack facade. */
export type ZenStackReadOperation =
  | "findUnique"
  | "findUniqueOrThrow"
  | "findFirst"
  | "findFirstOrThrow"
  | "findMany"
  | "count"
  | "aggregate"
  | "groupBy";

/** Structural facade so @supacloud/elysia does not depend on the DB package at runtime. */
export type ZenStackReadModels = object;

export interface ZenStackReadIdentityBinding {
  /** Read-only model facade returned after trusted identity verification. */
  readonly models: ZenStackReadModels;
  /** Identity used to create the facade; available to the argument builder only. */
  readonly identity: unknown;
}

export interface ZenStackReadInput {
  readonly request: Request;
  readonly params: Record<string, unknown>;
  readonly query: Record<string, unknown>;
  readonly headers: Record<string, unknown>;
  readonly identity: unknown;
}

export interface ZenStackReadResource {
  /** URL path. The path is registered as GET and HEAD only. */
  readonly path: string;
  /** Model key as exposed by ModelReadClient, for example `order`. */
  readonly model: string;
  readonly operation: ZenStackReadOperation;
  /** Optional TypeBox request/response schemas. */
  readonly contract?: RouteContractSchemas & { readonly response?: TSchema };
  /** Builds exact ZenStack query args from the decoded request and verified identity. */
  readonly args?: (input: ZenStackReadInput) => unknown;
}

export interface ZenStackReadAdapterOptions {
  readonly name?: string;
  readonly resources: readonly ZenStackReadResource[];
  /** Resolve and bind identity for every request. Never accept identity from query/body. */
  readonly bindIdentity: (request: Request) => Promise<ZenStackReadIdentityBinding> | ZenStackReadIdentityBinding;
}

const READ_OPERATIONS = new Set<ZenStackReadOperation>([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow",
  "findMany", "count", "aggregate", "groupBy",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function invokeRead(models: ZenStackReadModels, modelName: string, operation: ZenStackReadOperation, args: unknown): Promise<unknown> {
  const model = Reflect.get(models, modelName);
  if (!model || typeof model !== "object") throw new Error(`ZenStack read model is unavailable: ${modelName}`);
  const method = Reflect.get(model, operation);
  if (typeof method !== "function") throw new Error(`ZenStack read operation is unavailable: ${modelName}.${operation}`);
  return Promise.resolve(args === undefined
    ? Reflect.apply(method, model, [])
    : Reflect.apply(method, model, [args]));
}

/**
 * Mounts explicit, read-only ZenStack resources on native Elysia 2.
 *
 * This adapter intentionally does not use @zenstackhq/server automatic CRUD:
 * the current server package targets Elysia 1.x and its generic CRUD surface
 * would create a second application boundary. Each request binds identity,
 * selects a read-only facade, and calls one allow-listed operation.
 */
export function createZenStackReadPlugin(options: ZenStackReadAdapterOptions): Elysia {
  if (options.resources.length === 0) throw new TypeError("ZenStack read adapter requires at least one resource");
  const app = new Elysia({ name: options.name ?? "supacloud:zenstack-read" });
  const paths = new Set<string>();
  for (const resource of options.resources) {
    if (!resource.path.startsWith("/") || paths.has(resource.path)) {
      throw new TypeError(`Duplicate or invalid ZenStack read path: ${resource.path}`);
    }
    paths.add(resource.path);
    if (!READ_OPERATIONS.has(resource.operation)) {
      throw new TypeError(`Unsupported ZenStack read operation: ${resource.operation}`);
    }
    const contract = resource.contract ?? {};
    const schema = toElysiaRouteSchema(contract) as InputSchema<never>;
    const handler = async (context: Context): Promise<unknown> => {
      const binding = await options.bindIdentity(context.request);
      if (!binding || !isRecord(binding) || !isRecord(binding.models)
        || binding.identity === null || binding.identity === undefined) {
        throw new Error("ZenStack identity binding must provide a read-only models facade");
      }
      const input: ZenStackReadInput = {
        request: context.request,
        params: isRecord(context.params) ? context.params : {},
        query: isRecord(context.query) ? context.query : {},
        headers: isRecord(context.headers) ? context.headers : {},
        identity: binding.identity,
      };
      return invokeRead(binding.models, resource.model, resource.operation, resource.args?.(input));
    };
    app.get(resource.path, schema, handler);
    app.head(resource.path, schema, handler);
  }
  return app;
}
