export function isCiLikeRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.NODE_ENV === "test");
}

export function normalizeCiS3Endpoint(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Let the environment variables naturally resolve the endpoint.
  // We no longer forcefully rewrite 9001 -> 9000, as CI correctly exposes MinIO on 9001.
  return endpoint;
}

export function resolveRealtimeTenantHost(
  projectRef: string,
  requestHost: string,
  baseDomain: string,
): string {
  return projectRef ? `${projectRef}.api.${baseDomain}` : requestHost;
}