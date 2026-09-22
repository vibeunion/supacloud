export const page = $state<{ params: { ref: string | undefined } }>({ params: { ref: "a" } });
export const notifications: string[] = [];
export const toast = {
  success(message: string) { notifications.push(message); },
  error(message: string) { notifications.push(message); },
};
export function jwtFixture(projectRef = "a") {
  return {
    project_ref: projectRef, execution_mode: "local", authority_project_ref: projectRef,
    policy: { access_expiry: 3600, refresh_rotation: true },
    signing: {
      algorithm: "ES256", key_id: `key-${projectRef}`, issuer: `https://${projectRef}.example.test/auth/v1`,
      jwks_url: `https://${projectRef}.example.test/auth/v1/.well-known/jwks.json`,
      oauth_enabled: true, migration_status: "configured",
    },
  };
}
