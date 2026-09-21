export class InvalidStudioSessionResponse extends Error {
  constructor() { super("Invalid Studio session response"); }
}

export type StudioSessionState =
  | { authenticated: true; username: string; expiresAt: string }
  | { authenticated: false };

export type StudioLoginResult =
  | { success: true; username: string }
  | { success: false; error: string };

export type StudioLogoutResult =
  | { success: true }
  | { success: false; error: string };

function receipt(value: unknown, key: "valid" | "success", accepted: boolean): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new InvalidStudioSessionResponse();
  const data: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (data[key] !== accepted) throw new InvalidStudioSessionResponse();
  for (const field of ["valid", "authenticated", "success"]) {
    if (Object.hasOwn(data, field) && data[field] !== accepted) throw new InvalidStudioSessionResponse();
  }
  if (!accepted && (Object.hasOwn(data, "username") || Object.hasOwn(data, "expires_at"))) {
    throw new InvalidStudioSessionResponse();
  }
  return data;
}

export function parseStudioSession(
  value: unknown,
  status: number,
  kind: "session" | "login" | "refresh",
): StudioSessionState {
  const key = kind === "session" ? "valid" : "success";
  if (status !== 200) {
    const failures = kind === "session" ? [401] : kind === "refresh" ? [401, 403] : [401, 403, 429];
    if (!failures.includes(status)) throw new InvalidStudioSessionResponse();
    receipt(value, key, false);
    return { authenticated: false };
  }
  const data = receipt(value, key, true);
  if (typeof data.username !== "string" || !data.username.trim() || data.username.length > 320
    || typeof data.expires_at !== "string") throw new InvalidStudioSessionResponse();
  const expiry = new Date(data.expires_at);
  if (!Number.isFinite(expiry.getTime()) || expiry.toISOString() !== data.expires_at
    || expiry.getTime() <= Date.now()) throw new InvalidStudioSessionResponse();
  return { authenticated: true, username: data.username, expiresAt: data.expires_at };
}

export function parseStudioLogout(value: unknown, status: number): StudioLogoutResult {
  if (status === 403) {
    receipt(value, "success", false);
    return { success: false, error: "Cross-origin session request denied" };
  }
  if (status !== 200) throw new InvalidStudioSessionResponse();
  receipt(value, "success", true);
  return { success: true };
}

export function studioLoginFailure(status: number): string {
  if (status === 401) return "Invalid username or password";
  if (status === 403) return "Cross-origin login request denied";
  if (status === 429) return "Too many failed login attempts";
  return "Login failed";
}
