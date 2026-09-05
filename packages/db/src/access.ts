/**
 * Driver-independent database access boundary for request-scoped user clients
 * and explicitly authorized service-role clients.
 */

export interface AuthenticatedDatabaseIdentity {
  subject: string;
  accessToken: string;
}

export interface DatabaseAccessBoundaryOptions<UserClient, ServiceClient> {
  createUserClient(
    identity: AuthenticatedDatabaseIdentity,
  ): UserClient | Promise<UserClient>;
  createServiceClient?: () => ServiceClient | Promise<ServiceClient>;
  /** Service-role access is denied unless the supplied reason is allowlisted. */
  allowedServiceReasons?: readonly string[];
}

export interface DatabaseAccessBoundary<UserClient, ServiceClient> {
  /** Create an RLS-preserving client for the verified request identity. */
  forUser(identity: AuthenticatedDatabaseIdentity): Promise<UserClient>;
  /** Return a cached service-role client for an explicitly allowlisted reason. */
  forService(reason: string): Promise<ServiceClient>;
}

export type DatabaseAccessErrorCode =
  | "DATABASE_IDENTITY_REQUIRED"
  | "DATABASE_ACCESS_TOKEN_REQUIRED"
  | "SERVICE_ROLE_UNAVAILABLE"
  | "SERVICE_ROLE_REASON_REQUIRED"
  | "SERVICE_ROLE_REASON_NOT_ALLOWED";

export class DatabaseAccessError extends Error {
  readonly expose = true as const;
  readonly code: DatabaseAccessErrorCode;
  readonly status: number;

  constructor(code: DatabaseAccessErrorCode, status: number, message: string) {
    super(message);
    this.name = "DatabaseAccessError";
    this.code = code;
    this.status = status;
  }
}

export function createDatabaseAccessBoundary<UserClient, ServiceClient = never>(
  options: DatabaseAccessBoundaryOptions<UserClient, ServiceClient>,
): DatabaseAccessBoundary<UserClient, ServiceClient> {
  const allowedReasons = new Set(options.allowedServiceReasons ?? []);
  let serviceClient: Promise<ServiceClient> | undefined;

  return {
    async forUser(identity) {
      if (!identity.subject) {
        throw new DatabaseAccessError(
          "DATABASE_IDENTITY_REQUIRED",
          401,
          "A verified user identity is required for request database access",
        );
      }
      if (!identity.accessToken) {
        throw new DatabaseAccessError(
          "DATABASE_ACCESS_TOKEN_REQUIRED",
          401,
          "A verified user access token is required for request database access",
        );
      }
      return options.createUserClient({
        subject: identity.subject,
        accessToken: identity.accessToken,
      });
    },

    async forService(reason) {
      const normalizedReason = reason.trim();
      if (!normalizedReason) {
        throw new DatabaseAccessError(
          "SERVICE_ROLE_REASON_REQUIRED",
          403,
          "Service-role database access requires a non-empty reason",
        );
      }
      if (!allowedReasons.has(normalizedReason)) {
        throw new DatabaseAccessError(
          "SERVICE_ROLE_REASON_NOT_ALLOWED",
          403,
          `Service-role database access reason "${normalizedReason}" is not allowed`,
        );
      }
      if (!options.createServiceClient) {
        throw new DatabaseAccessError(
          "SERVICE_ROLE_UNAVAILABLE",
          501,
          "Service-role database access is not configured",
        );
      }
      serviceClient ??= Promise.resolve(options.createServiceClient()).catch((error: unknown) => {
        serviceClient = undefined;
        throw error;
      });
      return serviceClient;
    },
  };
}
