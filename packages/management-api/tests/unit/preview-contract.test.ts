import { expect, test } from "bun:test";
import { PreviewEnvironmentError } from "../../src/services/preview-environment.service";
import {
  base32Lower,
  derivePreviewActivationId,
  derivePreviewResourceName,
  derivePreviewSecretRef,
  normalizePreviewSlug,
  uuidV5,
} from "../../src/services/preview-naming";
import {
  buildPreviewConfiguration,
  canonicalizePreviewConfiguration,
  deriveConfigurationId,
  validatePreviewConfiguration,
} from "../../src/services/preview-configuration.service";
import { PREVIEW_SANDBOX_PROVIDERS, assertSandboxAllowed, resolvePreviewSecrets } from "../../src/services/preview-secrets.service";
import { authorizePreviewAction } from "../../src/services/preview-authorization.service";

test("derives bounded preview slugs and deterministic resource names", () => {
  expect(normalizePreviewSlug("pr-1528")).toBe("pr-1528");
  expect(normalizePreviewSlug("Change_ABC")).toBe("change-abc");
  expect(normalizePreviewSlug("x".repeat(32)).length).toBeLessThanOrEqual(48);
  expect(() => normalizePreviewSlug("!!")).toThrow();

  expect(derivePreviewResourceName("namespace", "demo-project", "pr-1528")).toBe("pv_demo_project_pr-1528");
  expect(derivePreviewResourceName("database", "demo-project", "pr-1528")).toBe("pv_demo_project_pr-1528_db");
  expect(derivePreviewResourceName("queue", "demo-project", "pr-1528", "orders")).toBe("pv_demo_project_pr-1528_q_orders");
  expect(derivePreviewResourceName("bucket", "demo-project", "pr-1528", "uploads")).toBe("pv-demo-project-pr-1528-b-uploads");
  expect(derivePreviewResourceName("secret", "demo-project", "pr-1528", "stripe-key")).toBe("pv/demo_project/pr-1528/stripe_key");
});

test("derives a deterministic UUIDv5 activation identity", () => {
  const first = derivePreviewActivationId("demo-project", "pr-1528");
  const second = derivePreviewActivationId("demo-project", "pr-1528");
  expect(first).toBe(second);
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(derivePreviewActivationId("demo-project", "pr-1529")).not.toBe(first);
  expect(derivePreviewActivationId("other", "pr-1528")).not.toBe(first);
  expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "example")).toMatch(/^[0-9a-f-]{36}$/);
  expect(base32Lower(new Uint8Array([0xff, 0x00]))).toBe("74aa");
});

test("builds a content-addressed preview configuration", () => {
  const secretRef = derivePreviewSecretRef("demo-project", "pr-1528", "stripe-key");
  const built = buildPreviewConfiguration({
    projectId: "demo-project", previewRef: "pr-1528", releaseId: "a".repeat(64),
    command: "bun run start", port: 3000,
    environment: { LOG_LEVEL: "debug", FEATURE: true },
    allowedEnvironmentKeys: ["LOG_LEVEL", "FEATURE"],
    secretRefs: [secretRef],
    resourceRefs: { database: "project:preview-demo-db", queues: ["schema:orders"] },
    externalServices: { stripe: { mode: "sandbox", secretRef } },
  });
  expect(built.configurationId).toMatch(/^cfg_[a-z2-7]+$/);
  expect(deriveConfigurationId(canonicalizePreviewConfiguration(built.configuration))).toBe(built.configurationId);

  const changed = buildPreviewConfiguration({
    projectId: "demo-project", previewRef: "pr-1528", releaseId: "a".repeat(64),
    command: "bun run start", port: 3001,
    environment: { LOG_LEVEL: "debug", FEATURE: true },
    allowedEnvironmentKeys: ["LOG_LEVEL", "FEATURE"],
    secretRefs: [secretRef],
    externalServices: { stripe: { mode: "sandbox", secretRef } },
  });
  expect(changed.configurationId).not.toBe(built.configurationId);
});

test("rejects production-shaped or unsupported configuration", () => {
  const base = {
    projectId: "demo-project", previewRef: "pr-1528", releaseId: "a".repeat(64),
    command: "bun run start", port: 3000, allowedEnvironmentKeys: ["LOG_LEVEL", "DATABASE_URL"],
  };
  expect(() => buildPreviewConfiguration({ ...base, environment: { UNKNOWN: "x" } })).toThrow();
  expect(() => buildPreviewConfiguration({ ...base, environment: { DATABASE_URL: "postgres://prod/db" } })).toThrow();
  expect(() => buildPreviewConfiguration({ ...base, environment: { LOG_LEVEL: "production" } })).toThrow();
  expect(() => buildPreviewConfiguration({
    ...base, environment: {}, secretRefs: ["not-a-secret-ref"],
  })).toThrow();
  expect(() => buildPreviewConfiguration({
    ...base, environment: {}, externalServices: { stripe: { mode: "disabled", secretRef: "secret://preview/x/y/z" } },
  })).toThrow();

  const configuration = buildPreviewConfiguration({ ...base, environment: {} }).configuration;
  expect(() => validatePreviewConfiguration({ ...configuration, releaseId: "short" }, [])).toThrow();
});

test("resolves only sandbox-backed preview secrets", () => {
  expect(PREVIEW_SANDBOX_PROVIDERS.stripe).toBe(true);
  expect(() => assertSandboxAllowed("stripe")).not.toThrow();
  expect(() => assertSandboxAllowed("bank")).toThrow(new PreviewEnvironmentError("PREVIEW_ENVIRONMENT_INLINE_SECRET_FORBIDDEN"));

  const resolved = resolvePreviewSecrets({
    projectId: "demo-project", previewRef: "pr-1528", previewId: "pv-1",
    services: [{ provider: "stripe", secretName: "stripe-key" }, { provider: "sendgrid", secretName: "mail" }],
  });
  expect(resolved.map((secret) => secret.provider)).toEqual(["sendgrid", "stripe"]);
  expect(resolved[1]?.secretRef).toBe(derivePreviewSecretRef("demo-project", "pr-1528", "stripe-key"));

  expect(() => resolvePreviewSecrets({
    projectId: "demo-project", previewRef: "pr-1528", previewId: "pv-1",
    services: [{ provider: "bank", secretName: "wire" }],
  })).toThrow();
});

test("enforces the preview authorization matrix", () => {
  expect(authorizePreviewAction({ action: "close", role: "member", isOwner: true }).allowed).toBe(true);
  expect(authorizePreviewAction({ action: "close", role: "member", isOwner: false }).allowed).toBe(false);
  expect(authorizePreviewAction({ action: "full_clone", role: "member" }).allowed).toBe(false);
  expect(authorizePreviewAction({ action: "full_clone", role: "admin" }).allowed).toBe(true);
  expect(authorizePreviewAction({ action: "full_clone", role: "system" }).requiresApproval).toBe(true);
  expect(authorizePreviewAction({ action: "force_delete_bucket", role: "admin" }).allowed).toBe(false);
  expect(authorizePreviewAction({ action: "force_delete_bucket", role: "ops" }).allowed).toBe(true);
  expect(authorizePreviewAction({ action: "promote_migration", role: "admin" }).requiresApproval).toBe(true);
  expect(authorizePreviewAction({ action: "promote_migration", role: "member" }).allowed).toBe(false);
  expect(authorizePreviewAction({ action: "use_real_credentials", role: "ops" }).allowed).toBe(false);
});