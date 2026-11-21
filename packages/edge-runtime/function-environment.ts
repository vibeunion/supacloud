const FUNCTION_DATABASE_SECRET = /^APP_[A-Z][A-Z0-9_]*_DATABASE_URL$/i;

// A trusted Function can use the project data plane without inheriting control-plane secrets.
const PROJECT_API_ENV = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPACLOUD_INTERNAL_REST_URL",
  "SUPACLOUD_IMAGE_TRANSFORM_URL",
];

export function projectFunctionEnvironment(
  env: Record<string, string>,
  { secrets, bindings }: { secrets?: readonly string[]; bindings?: readonly string[] },
): Record<string, string> {
  if (secrets === undefined) {
    // App database bindings are private by default, including in legacy Functions.
    return Object.fromEntries(Object.entries(env).filter(([name]) => !FUNCTION_DATABASE_SECRET.test(name)));
  }
  const allowed = new Set(secrets);
  if (bindings?.includes("project_api")) {
    for (const name of PROJECT_API_ENV) allowed.add(name);
  }
  return Object.fromEntries(Object.entries(env).filter(([name]) => allowed.has(name)));
}
