import { describe, expect, mock, test } from "bun:test";
import type { SQL } from "bun";
import {
  hasSecretEncryptionCheckpoint,
  migrateLegacyEncryptedSecrets,
  migrateLegacyEncryptedSecretsInTransaction,
} from "../../src/db/secret-key-migration";
import { decryptSecretWithKey, encryptSecretWithKey } from "../../src/utils/secret-crypto";

const CURRENT_KEY = "current-encryption-key-0123456789abcdef";
const LEGACY_KEY = "legacy-encryption-key-0123456789abcdef";

type MigrationState = {
  projects: Array<Record<string, unknown>>;
  projectSecrets: Array<Record<string, unknown>>;
  controlSecrets: Array<Record<string, unknown>>;
  platformSettings: Array<Record<string, unknown>>;
  webhooks: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  checkpoints: Array<Record<string, unknown>>;
};

function legacyCiphertext(plaintext: string): string {
  return encryptSecretWithKey(plaintext, LEGACY_KEY);
}

function queryText(strings: TemplateStringsArray): string {
  return strings.join("?").replaceAll(/\s+/g, " ").trim();
}

function replaceState(target: MigrationState, snapshot: MigrationState): void {
  for (const key of Object.keys(target) as Array<keyof MigrationState>) {
    target[key].splice(0, target[key].length, ...structuredClone(snapshot[key]));
  }
}

function migrationDatabase(state: MigrationState) {
  const transaction = Object.assign(
    mock(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = queryText(strings);
      if (query.includes("FROM projects")) return structuredClone(state.projects);
      if (query.includes("FROM project_secrets")) return structuredClone(state.projectSecrets);
      if (query.includes("FROM project_control_secrets")) return structuredClone(state.controlSecrets);
      if (query.includes("FROM platform_settings")) {
        return structuredClone(state.platformSettings.filter(({ key, is_secret }) => is_secret === true || key === "ai_api_key"));
      }
      if (query.includes("FROM project_webhooks")) return structuredClone(state.webhooks);
      if (query.includes("FROM project_tasks")) return structuredClone(state.tasks);
      if (query.includes("FROM secret_encryption_checkpoints")) {
        const checkpoints = state.checkpoints.filter(({ scheme, key_fingerprint }) => (
          scheme === values[0] && key_fingerprint === values[1]
        ));
        return query.startsWith("SELECT 1 AS present")
          ? checkpoints.map(() => ({ present: 1 }))
          : structuredClone(checkpoints);
      }
      if (query.includes("to_regclass('public.secret_encryption_checkpoints')")) {
        return [{ checkpoint_table_exists: true }];
      }
      if (query.startsWith("UPDATE projects SET")) {
        const row = state.projects.find(({ ref }) => ref === values[5]);
        if (row) [
          row.db_password_encrypted,
          row.jwt_secret_encrypted,
          row.service_role_key_encrypted,
          row.secret_key_encrypted,
          row.s3_secret_key_encrypted,
        ] = values.slice(0, 5);
      } else if (query.startsWith("UPDATE project_secrets")) {
        const row = state.projectSecrets.find(({ id }) => id === values[1]);
        if (row) row.value = values[0];
      } else if (query.startsWith("UPDATE project_control_secrets")) {
        const row = state.controlSecrets.find(({ project_ref, scope, name }) => (
          project_ref === values[1] && scope === values[2] && name === values[3]
        ));
        if (row) row.value_encrypted = values[0];
      } else if (query.startsWith("UPDATE platform_settings")) {
        const row = state.platformSettings.find(({ key }) => key === values[1]);
        if (row) [row.value, row.is_secret] = [values[0], true];
      } else if (query.startsWith("UPDATE project_webhooks")) {
        const row = state.webhooks.find(({ id }) => id === values[2]);
        if (row) [row.secret_encrypted, row.previous_secret_encrypted] = values.slice(0, 2);
      } else if (query.startsWith("UPDATE project_tasks")) {
        const row = state.tasks.find(({ id }) => id === values[1]);
        if (row) row.payload = JSON.parse(String(values[0]));
      } else if (query.startsWith("INSERT INTO secret_encryption_checkpoints")) {
        const exists = state.checkpoints.some(({ scheme, key_fingerprint }) => (
          scheme === values[0] && key_fingerprint === values[1]
        ));
        if (!exists) {
          state.checkpoints.push({
            scheme: values[0],
            key_fingerprint: values[1],
            rotated_count: values[2],
            verified_count: values[3],
          });
        }
      }
      return [];
    }),
    { unsafe: mock(async () => []) },
  );
  const database = {
    begin: async (callback: (sql: SQL) => Promise<unknown>) => {
      const snapshot = structuredClone(state);
      try {
        return await callback(transaction as unknown as SQL);
      } catch (error: unknown) {
        replaceState(state, snapshot);
        throw error;
      }
    },
  };
  return { database: database as unknown as SQL, transaction };
}

function migrationState(): MigrationState {
  return {
    projects: [{
      ref: "project-one",
      db_password_encrypted: legacyCiphertext("database-password"),
      jwt_secret_encrypted: encryptSecretWithKey("jwt-secret", CURRENT_KEY),
      service_role_key_encrypted: "plaintext-service-role",
      secret_key_encrypted: null,
      s3_secret_key_encrypted: legacyCiphertext("s3-secret"),
    }],
    projectSecrets: [{ id: "project-secret", value: legacyCiphertext("edge-secret") }],
    controlSecrets: [{
      project_ref: "project-one",
      scope: "captcha",
      name: "hcaptcha",
      value_encrypted: legacyCiphertext("captcha-secret"),
    }],
    platformSettings: [
      { key: "ai_api_key", value: "plaintext-ai-secret", is_secret: false },
      { key: "ai_model", value: "gpt-test", is_secret: false },
    ],
    webhooks: [{
      id: "webhook-one",
      secret_encrypted: legacyCiphertext("webhook-secret"),
      previous_secret_encrypted: legacyCiphertext("previous-webhook-secret"),
    }],
    tasks: [
      {
        id: "pending-task",
        status: "pending",
        payload: { auth: { authorization: legacyCiphertext("Bearer user"), apikey: "plaintext-apikey" } },
      },
      {
        id: "completed-task",
        status: "succeeded",
        payload: { auth: { authorization: legacyCiphertext("historical-bearer"), apikey: null } },
      },
    ],
    checkpoints: [],
  };
}

function decryptCurrent(value: unknown): string {
  return decryptSecretWithKey(String(value), CURRENT_KEY);
}

describe("legacy secret encryption key migration", () => {
  test("rotates every authoritative secret source and persists a verified checkpoint", async () => {
    const state = migrationState();
    const { database, transaction } = migrationDatabase(state);

    const first = await migrateLegacyEncryptedSecrets(database, { currentKey: CURRENT_KEY, legacyKey: LEGACY_KEY });
    expect(first).toEqual({ rotated: 11, verified: 12 });
    expect(transaction.unsafe).toHaveBeenCalledTimes(1);
    expect(decryptCurrent(state.projects[0]?.db_password_encrypted)).toBe("database-password");
    expect(decryptCurrent(state.projects[0]?.jwt_secret_encrypted)).toBe("jwt-secret");
    expect(decryptCurrent(state.projects[0]?.service_role_key_encrypted)).toBe("plaintext-service-role");
    expect(decryptCurrent(state.projectSecrets[0]?.value)).toBe("edge-secret");
    expect(decryptCurrent(state.controlSecrets[0]?.value_encrypted)).toBe("captcha-secret");
    expect(decryptCurrent(state.platformSettings[0]?.value)).toBe("plaintext-ai-secret");
    expect(state.platformSettings[0]?.is_secret).toBe(true);
    expect(decryptCurrent(state.webhooks[0]?.secret_encrypted)).toBe("webhook-secret");
    expect(decryptCurrent(state.webhooks[0]?.previous_secret_encrypted)).toBe("previous-webhook-secret");
    const pendingAuth = (state.tasks[0]?.payload as { auth: Record<string, string> }).auth;
    expect(decryptCurrent(pendingAuth.authorization)).toBe("Bearer user");
    expect(decryptCurrent(pendingAuth.apikey)).toBe("plaintext-apikey");
    const completedAuth = (state.tasks[1]?.payload as { auth: Record<string, string> }).auth;
    expect(decryptCurrent(completedAuth.authorization)).toBe("historical-bearer");
    expect(await hasSecretEncryptionCheckpoint(transaction as unknown as SQL, CURRENT_KEY)).toBe(true);

    const second = await migrateLegacyEncryptedSecrets(database, { currentKey: CURRENT_KEY });
    expect(second).toEqual({ rotated: 0, verified: 12 });
  });

  test("rotates task credentials across every retry and terminal status", async () => {
    const statuses = ["pending", "leased", "running", "retry_scheduled", "failed", "dead_lettered", "cancelled", "succeeded"];
    const state = migrationState();
    state.tasks = statuses.map((status) => ({
      id: `task-${status}`,
      status,
      payload: { auth: { authorization: legacyCiphertext(`Bearer ${status}`), apikey: null } },
    }));
    const { database } = migrationDatabase(state);

    await migrateLegacyEncryptedSecrets(database, { currentKey: CURRENT_KEY, legacyKey: LEGACY_KEY });

    for (const task of state.tasks) {
      const auth = (task.payload as { auth: Record<string, string> }).auth;
      expect(decryptCurrent(auth.authorization)).toBe(`Bearer ${task.status}`);
    }
  });

  test("rolls the entire batch back when any ciphertext matches neither key", async () => {
    const state = migrationState();
    state.webhooks[0]!.previous_secret_encrypted = "enc:v1:not-valid-ciphertext";
    const before = structuredClone(state);
    const { database } = migrationDatabase(state);

    await expect(migrateLegacyEncryptedSecrets(database, {
      currentKey: CURRENT_KEY,
      legacyKey: LEGACY_KEY,
    })).rejects.toThrow("current or legacy encryption key");
    expect(state).toEqual(before);
  });

  test("rolls rotation and its checkpoint back when a later init-db step fails", async () => {
    const state = migrationState();
    const before = structuredClone(state);
    const { database } = migrationDatabase(state);

    await expect(database.begin(async (transaction) => {
      await migrateLegacyEncryptedSecretsInTransaction(transaction, {
        currentKey: CURRENT_KEY,
        legacyKey: LEGACY_KEY,
      });
      throw new Error("post-rotation init failure");
    })).rejects.toThrow("post-rotation init failure");

    expect(state).toEqual(before);
  });

  test("fails closed when legacy ciphertext exists without an explicit migration key", async () => {
    const state = migrationState();
    const before = structuredClone(state);
    const { database } = migrationDatabase(state);

    await expect(migrateLegacyEncryptedSecrets(database, { currentKey: CURRENT_KEY }))
      .rejects.toThrow("no legacy key was provided");
    expect(state).toEqual(before);
  });
});
