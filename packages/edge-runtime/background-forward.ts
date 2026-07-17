import { withBackgroundInternalToken } from "./tenant-env";
import { VERIFIED_JWT_SUB_HEADER } from "./jwt-verifier";

export interface BackgroundForwardDispatch {
  forwardedRequest: Request;
  backgroundInternalToken: string;
  tenantEnv: Record<string, string>;
}

export function createBackgroundInvocationToken(): string {
  return crypto.randomUUID();
}

export function buildBackgroundForwardedRequest(
  request: Request,
  backgroundInternalToken?: string,
): Request {
  const headers = new Headers(request.headers);
  const originalAuthorization = headers.get("x-supacloud-auth-authorization");
  const originalApikey = headers.get("x-supacloud-auth-apikey");

  headers.delete("x-supacloud-internal-auth");
  headers.delete("x-supacloud-internal-token");
  headers.delete("x-supacloud-auth-authorization");
  headers.delete("x-supacloud-auth-apikey");
  headers.delete(VERIFIED_JWT_SUB_HEADER);

  if (backgroundInternalToken) {
    headers.set("x-supacloud-internal-auth", `Bearer ${backgroundInternalToken}`);
  }

  if (originalAuthorization) {
    headers.set("authorization", originalAuthorization);
  } else {
    headers.delete("authorization");
  }

  if (originalApikey) {
    headers.set("apikey", originalApikey);
  } else {
    headers.delete("apikey");
  }

  return new Request(request.url, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    duplex: ["GET", "HEAD"].includes(request.method) ? undefined : "half",
  } as RequestInit & { duplex?: "half" });
}

export function buildBackgroundForwardDispatch(
  request: Request,
  tenantEnv: Record<string, string>,
  backgroundInternalToken = createBackgroundInvocationToken(),
): BackgroundForwardDispatch {
  return {
    forwardedRequest: buildBackgroundForwardedRequest(request, backgroundInternalToken),
    backgroundInternalToken,
    tenantEnv: withBackgroundInternalToken(tenantEnv, backgroundInternalToken),
  };
}
