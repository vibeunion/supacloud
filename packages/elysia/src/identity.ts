import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import {
  ApplicationError,
  createSupaCloudRequestContext,
  type SupaCloudRequestContext,
  type TrustedRequestIdentity,
} from "./index";

export interface SupAuthIdentity extends TrustedRequestIdentity {
  authenticated: true;
  subject: string;
  issuer: string;
  clientId: string;
}

export interface SupAuthAccess {
  projectId: string;
  tenantId: string;
  permissions: readonly string[];
}

export interface SupAuthRequestContext extends SupaCloudRequestContext {
  identity: SupAuthIdentity;
  access: Readonly<SupAuthAccess>;
}

export interface SupAuthContextOptions {
  issuer: string;
  audience: string;
  /** SupAuth OAuth application binding, independent of audience/project membership. */
  clientId: string;
  projectId: string;
  /** Explicit trusted JWKS endpoint; never read from a token's jku/x5u header. */
  jwksUrl: string;
  /** Defaults to ES256 and RS256; symmetric algorithms are not supported. */
  algorithms?: readonly ("ES256" | "RS256")[];
  /** Trusted host override for pinned/local keys and deterministic tests. */
  keyResolver?: JWTVerifyGetKey;
  /** Read current application-local access, not user-supplied tenant headers. */
  resolveAccess(identity: Readonly<SupAuthIdentity>, request: Request): Promise<SupAuthAccess | null>;
}

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("Identity endpoints must be HTTPS URLs without credentials or fragments");
  }
  return url;
}

/**
 * External user-center verification only. SupAuth/GoTrue still owns login,
 * passwords, sessions and token issuance; applications own access decisions.
 */
export function createSupAuthRequestContext(options: SupAuthContextOptions) {
  httpsUrl(options.issuer);
  const jwksUrl = httpsUrl(options.jwksUrl);
  if (!options.audience.trim() || !options.projectId.trim() || !options.clientId?.trim()) {
    throw new TypeError("SupAuth audience, clientId and projectId are required");
  }
  const algorithms = [...(options.algorithms ?? ["ES256", "RS256"])];
  if (!algorithms.length || algorithms.some((value) => value !== "ES256" && value !== "RS256")) {
    throw new TypeError("SupAuth requires ES256 or RS256");
  }
  const { issuer, audience, clientId, projectId, resolveAccess } = options;
  const keyResolver = options.keyResolver ?? createRemoteJWKSet(jwksUrl, { timeoutDuration: 5_000 });

  return async (request: Request): Promise<SupAuthRequestContext> => {
    const match = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i);
    const token = match?.[1];
    if (!token || token.length > 16_384) throw unauthenticated();
    let subject: string;
    try {
      const { payload } = await jwtVerify(token, keyResolver, {
        issuer,
        audience,
        algorithms,
        requiredClaims: ["sub", "exp", "iat"],
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim() ||
        payload.sub.length > 1_024 || /[\u0000-\u001f\u007f]/.test(payload.sub)) {
        throw unauthenticated();
      }
      const application = payload.client_id ?? payload.azp;
      if (application !== clientId || payload.role !== "authenticated" ||
        (payload.client_id !== undefined && payload.client_id !== clientId) ||
        (payload.azp !== undefined && payload.azp !== clientId)) {
        throw unauthenticated();
      }
      subject = payload.sub;
    } catch (error) {
      // Do not expose tokens, verifier causes, endpoints or claims in public errors.
      if (error instanceof ApplicationError ||
        error instanceof errors.JWTClaimValidationFailed ||
        error instanceof errors.JWTExpired ||
        error instanceof errors.JWTInvalid ||
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWSSignatureVerificationFailed ||
        error instanceof errors.JOSEAlgNotAllowed ||
        error instanceof errors.JOSENotSupported ||
        error instanceof errors.JWKSNoMatchingKey) throw unauthenticated();
      throw new ApplicationError("Identity verification service unavailable", {
        status: 503, code: "AUTHENTICATION_UNAVAILABLE",
      });
    }
    const identity: SupAuthIdentity = { authenticated: true, subject, issuer, clientId };
    Object.defineProperty(identity, "accessToken", { value: token, enumerable: false });
    Object.freeze(identity);
    const access = await resolveAccess(identity, request);
    if (!access || access.projectId !== projectId ||
      typeof access.tenantId !== "string" || !access.tenantId.trim() ||
      !Array.isArray(access.permissions) ||
      access.permissions.some((permission) => typeof permission !== "string" || !permission.trim())) {
      throw new ApplicationError("Application access denied", { status: 403, code: "APPLICATION_ACCESS_DENIED" });
    }
    // Preserve correlation/idempotency parsing, but discard forwarded identity.
    const context = createSupaCloudRequestContext(request);
    return {
      ...context,
      identity,
      access: Object.freeze({
        projectId,
        tenantId: access.tenantId,
        permissions: Object.freeze([...new Set(access.permissions)]),
      }),
    };
  };
}

function unauthenticated(): ApplicationError {
  return new ApplicationError("Authenticated user context is required", {
    status: 401,
    code: "AUTHENTICATION_REQUIRED",
  });
}
