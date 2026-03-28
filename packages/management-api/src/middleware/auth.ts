import { config } from "../config";

/**
 * Validate the Authorization header. Returns error response body if invalid,
 * or undefined if the request is authorized.
 */
export function checkAuth(request: Request): { status: number; body: { error: string } } | undefined {
  const authorization = request.headers.get("authorization");

  if (!authorization) {
    return { status: 401, body: { error: "Missing Authorization header" } };
  }

  if (!authorization.startsWith("Bearer ")) {
    return { status: 401, body: { error: "Invalid Authorization format" } };
  }

  const token = authorization.slice(7);

  if (token !== config.masterToken) {
    return { status: 403, body: { error: "Invalid token" } };
  }

  // Token valid
  return undefined;
}
