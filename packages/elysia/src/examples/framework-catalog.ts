import { Elysia, t } from "elysia";
import { createSupaCloudFramework } from "../framework";
import { ApplicationError, type CompiledModule } from "../index";

export interface CatalogIdentity {
  tenantId: string;
  subject: string;
}

export interface CatalogItem {
  id: string;
  name: string;
}

export interface CatalogPorts {
  /** Resolve credentials using a trusted verifier, never a tenant header alone. */
  authenticate(request: Request): Promise<CatalogIdentity>;
  /** The repository must apply this verified identity to its authorization. */
  read(identity: CatalogIdentity, id: string): Promise<CatalogItem>;
}

class CatalogController {
  constructor(
    private readonly ports: CatalogPorts,
    private readonly identity: CatalogIdentity,
  ) {}

  read(input: { params: { id: string } }) {
    return this.ports.read(this.identity, input.params.id);
  }
}

function catalogIdentity(value: unknown): CatalogIdentity {
  if (typeof value !== "object" || value === null
    || !("tenantId" in value) || typeof value.tenantId !== "string" || !value.tenantId
    || !("subject" in value) || typeof value.subject !== "string" || !value.subject) {
    throw new ApplicationError("Authentication required", {
      status: 401, code: "AUTHENTICATION_REQUIRED",
    });
  }
  return { tenantId: value.tenantId, subject: value.subject };
}

/**
 * A handwritten adapter fixture, not compiler output or a new module format.
 * Real applications can supply the existing compiler's createCompiledModules().
 */
export function createCatalogModule(ports: CatalogPorts): CompiledModule {
  return {
    name: "catalog",
    createServices: () => ({}),
    createRequestScope: (_services, context) => ({
      catalog: new CatalogController(ports, catalogIdentity(context)),
    }),
    controllers: [{
      path: "/catalog",
      serviceKey: "catalog",
      scope: "request",
      routes: [{
        method: "GET",
        path: "/:id",
        handler: "read",
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        query: t.Object({}),
        responses: { 200: t.Object({ id: t.String(), name: t.String() }) },
      }],
    }],
  };
}

export function createCatalogApplication(ports: CatalogPorts) {
  return createSupaCloudFramework({
    name: "catalog-prototype",
    http: new Elysia({ name: "catalog-clock" }).decorate("clock", () => Date.now()),
    modules: [createCatalogModule(ports)],
    requestContext: request => ports.authenticate(request),
  }).get("/health", ({ clock }) => ({ ok: true, time: clock() }));
}
