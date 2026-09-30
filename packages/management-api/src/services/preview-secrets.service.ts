import { PreviewEnvironmentError } from "./preview-environment.service";
import { derivePreviewSecretRef } from "./preview-naming";

/**
 * Preview secret policy: only providers with a platform sandbox may be enabled.
 * Everything else must be explicitly `disabled`; a production credential is
 * never used as a fallback.
 */
export const PREVIEW_SANDBOX_PROVIDERS: Readonly<Record<string, true>> = Object.freeze({
  stripe: true,
  paypal: true,
  sendgrid: true,
  sentry: true,
  oauth: true,
  webhook: true,
});

/** Services that stay disabled unless a sandbox provider is registered. */
export const PREVIEW_NEVER_ENABLED_SERVICES: ReadonlyArray<string> = Object.freeze([
  "bank", "wire-transfer", "payout", "sms", "email-outbound", "production-oauth", "production-webhook",
]);

export interface PreviewSecretRequest {
  provider: string;
  secretName: string;
}

export interface ResolvedPreviewSecret {
  name: string;
  mode: "sandbox";
  secretRef: string;
  provider: string;
  previewId: string;
}

export function assertSandboxAllowed(
  provider: string,
  registry: Readonly<Record<string, true>> = PREVIEW_SANDBOX_PROVIDERS,
): void {
  if (typeof provider !== "string" || provider.length === 0 || registry[provider] !== true) {
    throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INLINE_SECRET_FORBIDDEN");
  }
}

/**
 * Resolve sandbox secret references. Providers without a sandbox are refused, so
 * a Preview never silently reaches a production credential.
 */
export function resolvePreviewSecrets(input: {
  projectId: string;
  previewRef: string;
  previewId: string;
  services: ReadonlyArray<PreviewSecretRequest>;
  registry?: Readonly<Record<string, true>>;
}): ResolvedPreviewSecret[] {
  const seen = new Set<string>();
  return [...input.services]
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.secretName.localeCompare(b.secretName))
    .map((service) => {
      assertSandboxAllowed(service.provider, input.registry ?? PREVIEW_SANDBOX_PROVIDERS);
      const secretRef = derivePreviewSecretRef(input.projectId, input.previewRef, service.secretName);
      if (seen.has(secretRef)) throw new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INVALID");
      seen.add(secretRef);
      return {
        name: service.secretName,
        mode: "sandbox" as const,
        secretRef,
        provider: service.provider,
        previewId: input.previewId,
      };
    });
}