export function isCiLikeRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.NODE_ENV === "test");
}

export function normalizeCiS3Endpoint(
  endpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (
    isCiLikeRuntime(env) &&
    /(^https?:\/\/(?:127\.0\.0\.1|localhost):)9001(?=\/|$)/.test(endpoint)
  ) {
    return endpoint.replace(
      /(^https?:\/\/(?:127\.0\.0\.1|localhost):)9001(?=\/|$)/,
      "$19000",
    );
  }

  return endpoint;
}

export function resolveRealtimeTenantHost(
  projectRef: string,
  requestHost: string,
  baseDomain: string,
): string {
  return projectRef ? `${projectRef}.api.${baseDomain}` : requestHost;
}