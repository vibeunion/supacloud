export const DEFAULT_OAUTH_AUTHORIZATION_PATH = "/authorize.html";

export class OAuthAuthorizationPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthAuthorizationPathError";
  }
}

function validateRawAuthorizationPath(input: string): void {
  if (!input || input !== input.trim()) {
    throw new OAuthAuthorizationPathError("authorization_path must be a non-empty origin-relative path");
  }
  if (!input.startsWith("/") || input.includes("//")) {
    throw new OAuthAuthorizationPathError("authorization_path must start with one slash and cannot contain //");
  }
  if (/[\\?#\u0000-\u001f\u007f]/.test(input)) {
    throw new OAuthAuthorizationPathError("authorization_path cannot contain query, fragment, backslash, or control characters");
  }
}

function decodeAuthorizationPath(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch (error) {
    if (error instanceof URIError) {
      throw new OAuthAuthorizationPathError("authorization_path contains invalid percent encoding");
    }
    throw error;
  }
}

function validateDecodedAuthorizationPath(decodedPath: string): void {
  if (decodedPath.includes("//") || /[\\?#\u0000-\u001f\u007f]/.test(decodedPath)) {
    throw new OAuthAuthorizationPathError("authorization_path contains an unsafe encoded delimiter");
  }
  if (decodedPath.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new OAuthAuthorizationPathError("authorization_path cannot contain dot traversal segments");
  }
}

export function validateOAuthAuthorizationPath(input: string): string {
  validateRawAuthorizationPath(input);
  validateDecodedAuthorizationPath(decodeAuthorizationPath(input));
  return input;
}

export function resolveOAuthAuthorizationPath(
  explicitPath: unknown,
  currentPath: unknown,
): string {
  if (explicitPath !== undefined) {
    if (typeof explicitPath !== "string") {
      throw new OAuthAuthorizationPathError("authorization_path must be a string");
    }
    return validateOAuthAuthorizationPath(explicitPath);
  }
  if (typeof currentPath === "string") {
    try {
      return validateOAuthAuthorizationPath(currentPath);
    } catch (error) {
      if (!(error instanceof OAuthAuthorizationPathError)) throw error;
    }
  }
  return DEFAULT_OAUTH_AUTHORIZATION_PATH;
}
