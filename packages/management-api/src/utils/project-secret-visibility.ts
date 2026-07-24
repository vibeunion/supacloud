const SYSTEM_MANAGED_SECRET_NAMES = new Set([
  "JWT_SECRET",
  "JWT_KEYS",
  "JWT_JWKS",
  "X_PROJECT_REF",
  "WECHAT_MINIPROGRAM_APP_ID",
  "WECHAT_MINIPROGRAM_APP_SECRET",
  "WECHAT_MP_APP_ID",
  "WECHAT_MP_APP_SECRET",
  "WECHAT_MP_REDIRECT_URI",
]);

const SYSTEM_MANAGED_SECRET_PREFIXES = [
  "ADMIN_SSO_",
  "SUPABASE_",
  "SUPACLOUD_",
  "SUPAOAUTH_",
] as const;

export function isSystemManagedProjectSecretName(name: string): boolean {
  const normalized = name.trim().toUpperCase();
  return SYSTEM_MANAGED_SECRET_NAMES.has(normalized)
    || SYSTEM_MANAGED_SECRET_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isUserManagedProjectSecretName(name: string): boolean {
  return !isSystemManagedProjectSecretName(name);
}

export function isUserManagedFunctionSecretName(name: string): boolean {
  return name.trim().toUpperCase().startsWith("EDGEFN_");
}
