import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import {
  ensurePlatformV2Schema,
  migrateLegacyControlSecrets,
  migrateLegacyProviderLinkingConfig,
  migrateLegacyProjectWebhooks,
  migrateUnsupportedWebAuthnConfig,
  migrateWebhookSecretsToControlStore,
} from "../../src/db/platform-v2";

type ProjectState = {
  ref: string;
  config: unknown;
};

function migrationDatabase(project: ProjectState) {
  const storedSecrets: Array<{ scope: string; name: string; encrypted: string }> = [];
  const storedWebhooks: Array<{ id: string; legacyId: string; secretEncrypted?: string | null }> = [];
  const database = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT ref, config")) return Promise.resolve([{ ...project }]);
    if (query.includes("INSERT INTO project_control_secrets")) {
      const webhookScope = query.includes("'webhook'");
      storedSecrets.push({
        scope: webhookScope ? "webhook" : String(values[1]),
        name: String(values[webhookScope ? 1 : 2]),
        encrypted: String(values[webhookScope ? 2 : 3]),
      });
      return Promise.resolve([]);
    }
    if (query.includes("SET config = ?::jsonb")) {
      project.config = values[0];
      return Promise.resolve([]);
    }
    if (query.includes("config->'webhooks'")) {
      const config = project.config as Record<string, unknown>;
      return Promise.resolve(Array.isArray(config.webhooks) ? [{ ...project }] : []);
    }
    if (query.includes("INSERT INTO project_webhooks")) {
      storedWebhooks.push({ id: String(values[0]), legacyId: String(values[2]) });
      return Promise.resolve([{ id: values[0] }]);
    }
    return Promise.resolve([]);
  });
  return { database: database as unknown as SQL, storedSecrets, storedWebhooks };
}

describe("platform v2 migrations", () => {
  test("keeps config as an object while control secrets and webhooks migrate in sequence", async () => {
    const project: ProjectState = {
      ref: "proj_1",
      config: {
        auth: {
          external: { github: { client_id: "client", client_secret: "github-secret" } },
          security_captcha_provider: "hcaptcha",
          security_captcha_secret: "captcha-secret",
          hooks: { custom_access_token_hook: { enabled: true, secrets: "hook-secret" } },
        },
        webhooks: [{ id: "legacy-webhook", url: "https://hooks.example.test", events: ["user.created"], secret: "webhook-secret" }],
      },
    };
    const { database, storedSecrets, storedWebhooks } = migrationDatabase(project);

    expect(await migrateLegacyControlSecrets(database)).toBe(3);
    expect(typeof project.config).toBe("object");
    const migratedAuth = JSON.stringify((project.config as Record<string, unknown>).auth);
    expect(migratedAuth).not.toContain("github-secret");
    expect(migratedAuth).not.toContain("captcha-secret");
    expect(migratedAuth).not.toContain("hook-secret");
    expect((project.config as Record<string, unknown>).webhooks).toBeArray();
    expect(storedSecrets.map(({ scope, name }) => `${scope}:${name}`)).toEqual([
      "connector:github",
      "captcha:hcaptcha",
      "auth-hook:custom_access_token_hook",
    ]);
    expect(storedSecrets.every(({ encrypted }) => encrypted.startsWith("enc:v1:"))).toBe(true);

    expect(await migrateLegacyProjectWebhooks(database)).toBe(1);
    expect(typeof project.config).toBe("object");
    expect((project.config as Record<string, unknown>).webhooks).toBeUndefined();
    expect(storedWebhooks).toHaveLength(1);
    expect(storedWebhooks[0]?.secretEncrypted).toBeUndefined();
    expect(storedSecrets.at(-1)).toMatchObject({ scope: "webhook" });
    expect(storedSecrets.at(-1)?.encrypted).toStartWith("enc:v1:");
    expect(await migrateLegacyControlSecrets(database)).toBe(0);
    expect(await migrateLegacyProjectWebhooks(database)).toBe(0);
  });

  test("seeds owners only from verifiable organization members", async () => {
    let ownerSeedQuery = "";
    const unsafe = mock(() => Promise.resolve([]));
    const transaction = Object.assign(
      mock((strings: TemplateStringsArray) => {
        ownerSeedQuery = strings.join("?");
        return Promise.resolve([]);
      }),
      { unsafe },
    );

    await ensurePlatformV2Schema(transaction as unknown as SQL);

    expect(ownerSeedQuery).toContain("JOIN organization_members owner_member");
    expect(ownerSeedQuery).toContain("owner_member.user_id = o.owner_id");
    expect(ownerSeedQuery).not.toContain("platform:admin");
  });

  test("repairs a legacy JSON-string config before continuing later migrations", async () => {
    const project = {
      ref: "proj_legacy",
      config: JSON.stringify({
        auth: { security_captcha_secret: "captcha-secret" },
        webhooks: [{ id: "legacy", url: "https://hooks.example.test", events: ["*"], secret: "webhook-secret" }],
      }) as unknown as Record<string, unknown>,
    };
    const { database, storedSecrets, storedWebhooks } = migrationDatabase(project);

    expect(await migrateLegacyControlSecrets(database)).toBe(1);
    expect(typeof project.config).toBe("object");
    expect(await migrateLegacyProjectWebhooks(database)).toBe(1);
    expect(storedSecrets.map(({ scope }) => scope)).toEqual(["captcha", "webhook"]);
    expect(storedWebhooks).toHaveLength(1);
    expect((project.config as Record<string, unknown>).webhooks).toBeUndefined();
  });

  test("moves deprecated webhook columns into managed storage and clears their values", async () => {
    const legacyWebhook: {
      id: string;
      project_ref: string;
      secret_encrypted: string | null;
      previous_secret_encrypted: string | null;
    } = {
      id: "11111111-1111-4111-8111-111111111111",
      project_ref: "proj_1",
      secret_encrypted: "legacy-plaintext-secret",
      previous_secret_encrypted: "legacy-previous-secret",
    };
    const managedSecrets: Array<{ name: string; encrypted: string }> = [];
    const database = mock((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("FROM project_webhooks") && query.includes("secret_encrypted IS NOT NULL")) {
        return Promise.resolve(legacyWebhook.secret_encrypted ? [legacyWebhook] : []);
      }
      if (query.includes("INSERT INTO project_control_secrets")) {
        managedSecrets.push({ name: String(values[1]), encrypted: String(values[2]) });
      }
      if (query.includes("UPDATE project_webhooks")) {
        legacyWebhook.secret_encrypted = null;
        legacyWebhook.previous_secret_encrypted = null;
      }
      return Promise.resolve([]);
    }) as unknown as SQL;

    expect(await migrateWebhookSecretsToControlStore(database)).toBe(1);
    expect(managedSecrets).toEqual([{
      name: `webhook-${legacyWebhook.id}`,
      encrypted: expect.stringMatching(/^enc:v1:/),
    }]);
    expect(legacyWebhook.secret_encrypted).toBeNull();
    expect(legacyWebhook.previous_secret_encrypted).toBeNull();
    expect(await migrateWebhookSecretsToControlStore(database)).toBe(0);
  });

  test("removes every unsupported WebAuthn shape while preserving TOTP and phone MFA", async () => {
    const project: ProjectState = {
      ref: "proj_webauthn",
      config: {
        auth: {
          passkey_enabled: true,
          passkeyPolicy: { resident_key: true },
          webauthn: { rp_id: "example.test" },
          webauthn_timeout: 30,
          mfa_web_authn_enabled: true,
          mfa_webauthn_capacity: 5,
          password_min_length: 12,
          mfa: {
            totp: { enabled: true },
            phone: { enabled: true },
            webauthn: { enabled: true },
            web_authn: { enabled: true },
          },
        },
      },
    };
    const { database } = migrationDatabase(project);

    expect(await migrateUnsupportedWebAuthnConfig(database)).toBe(1);
    const auth = (project.config as { auth: Record<string, unknown> }).auth;
    expect(auth.password_min_length).toBe(12);
    expect(auth.passkey_enabled).toBeUndefined();
    expect(auth.passkeyPolicy).toBeUndefined();
    expect(auth.webauthn).toBeUndefined();
    expect(auth.webauthn_timeout).toBeUndefined();
    expect(auth.mfa_web_authn_enabled).toBeUndefined();
    expect(auth.mfa_webauthn_capacity).toBeUndefined();
    expect(auth.mfa).toEqual({
      totp: { enabled: true },
      phone: { enabled: true },
    });
    expect(await migrateUnsupportedWebAuthnConfig(database)).toBe(0);
  });

  test("migrates legacy provider linking into the sorted canonical map exactly once", async () => {
    const project: ProjectState = {
      ref: "proj_provider_linking",
      config: {
        auth: {
          experimental: {
            providers_with_own_linking_domain: ["google", "github", "custom:google"],
            provider_linking_domains: { github: "social", azure: "enterprise" },
            unrelated_setting: true,
          },
        },
      },
    };
    const { database } = migrationDatabase(project);

    expect(await migrateLegacyProviderLinkingConfig(database)).toBe(1);
    expect((project.config as { auth: { experimental: Record<string, unknown> } }).auth.experimental).toEqual({
      provider_linking_domains: {
        azure: "enterprise",
        "custom:google": "custom:google",
        github: "social",
        google: "google",
      },
      unrelated_setting: true,
    });
    expect(await migrateLegacyProviderLinkingConfig(database)).toBe(0);
  });

  test("fails closed on malformed legacy provider linking config", async () => {
    const project: ProjectState = {
      ref: "proj_invalid_provider_linking",
      config: {
        auth: {
          experimental: {
            providers_with_own_linking_domain: ["github", ""],
          },
        },
      },
    };
    const { database } = migrationDatabase(project);

    await expect(migrateLegacyProviderLinkingConfig(database)).rejects.toThrow("non-empty strings");
  });

  test("scrubs a legacy JSON-string config and rejects malformed JSON", async () => {
    const project: ProjectState = {
      ref: "proj_legacy_webauthn",
      config: JSON.stringify({
        auth: JSON.stringify({
          webauthn_enabled: true,
          mfa: { web_authn: { enabled: true }, totp: { enabled: true } },
        }),
      }),
    };
    const { database } = migrationDatabase(project);

    expect(await migrateUnsupportedWebAuthnConfig(database)).toBe(1);
    expect(project.config).toEqual({ auth: { mfa: { totp: { enabled: true } } } });

    project.config = "{not-json";
    await expect(migrateUnsupportedWebAuthnConfig(database)).rejects.toThrow("contains invalid JSON");
  });
});
