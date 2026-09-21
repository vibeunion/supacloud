// @supacloud-test-isolate
import { expect, mock, test } from "bun:test";
import { withNativePostgres } from "../helpers/native-postgres";
import { InvalidWebhookRecordError } from "../../src/utils/webhook-record";

test.skipIf(process.env.SUPACLOUD_MANAGEMENT_TEST_NATIVE !== "1")(
  "native webhook metadata and secret writes roll back together on invalid receipts",
  async () => withNativePostgres(async (database) => {
    const previousKey = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = "native-webhook-encryption-key-0123456789abcdef";
    try {
      const originalDb = await import("../../src/db");
      mock.module("../../src/db", () => ({ ...originalDb, sql: database }));
      const { webhookDeliveryService } = await import("../../src/services/webhook-delivery.service");
      await database.unsafe(`
        CREATE TABLE projects (ref text PRIMARY KEY, deleted_at timestamptz);
        INSERT INTO projects VALUES ('native-project', NULL);
        CREATE TABLE project_webhooks (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_ref varchar(20) NOT NULL REFERENCES projects(ref),
          legacy_id text, url text NOT NULL, events text[] NOT NULL, secret_encrypted text,
          previous_secret_encrypted text, secret_version integer NOT NULL DEFAULT 1,
          enabled boolean NOT NULL DEFAULT true, api_version varchar(20) NOT NULL DEFAULT '2026-07-01',
          created_by text, created_at timestamptz NOT NULL DEFAULT NOW(),
          updated_at timestamptz NOT NULL DEFAULT NOW(), deleted_at timestamptz
        );
        CREATE TABLE project_control_secrets (
          project_ref text NOT NULL REFERENCES projects(ref), scope text NOT NULL, name text NOT NULL,
          value_encrypted text NOT NULL, updated_at timestamptz DEFAULT NOW(),
          PRIMARY KEY (project_ref, scope, name)
        );
      `);
      const created = await webhookDeliveryService.createWebhook("native-project", {
        url: "https://hooks.example.com/events", events: ["user.created"], enabled: false,
      }, "native-actor");
      expect(created).toMatchObject({ enabled: false, has_secret: true, signing_key_id: "v1" });
      expect(created.created_at).toBeInstanceOf(Date);
      expect(await webhookDeliveryService.getWebhook("native-project", created.id.toUpperCase()))
        .toMatchObject({ id: created.id });
      const before: unknown = await database`
        SELECT name, value_encrypted FROM project_control_secrets WHERE project_ref = 'native-project'
      `;
      await database.unsafe(`
        CREATE FUNCTION corrupt_webhook_version() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.secret_version := 0; RETURN NEW; END $$;
        CREATE TRIGGER corrupt_webhook_version BEFORE UPDATE ON project_webhooks
          FOR EACH ROW EXECUTE FUNCTION corrupt_webhook_version();
      `);
      await expect(webhookDeliveryService.rotateSecret("native-project", created.id))
        .rejects.toBeInstanceOf(InvalidWebhookRecordError);
      const after: unknown = await database`
        SELECT name, value_encrypted FROM project_control_secrets WHERE project_ref = 'native-project'
      `;
      expect(after).toEqual(before);
      const version: unknown = await database`SELECT secret_version FROM project_webhooks WHERE id = ${created.id}::uuid`;
      expect(version).toEqual([{ secret_version: 1 }]);
      await database.unsafe("DROP TRIGGER corrupt_webhook_version ON project_webhooks");
      const rotations = await Promise.all([
        webhookDeliveryService.rotateSecret("native-project", created.id),
        webhookDeliveryService.rotateSecret("native-project", created.id),
      ]);
      expect(rotations.map(row => row.secret_version).sort()).toEqual([2, 3]);

      await database.unsafe(`
        CREATE FUNCTION omit_webhook_secret() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RETURN NULL; END $$;
        CREATE TRIGGER omit_webhook_secret BEFORE INSERT ON project_control_secrets
          FOR EACH ROW EXECUTE FUNCTION omit_webhook_secret();
      `);
      await expect(webhookDeliveryService.createWebhook("native-project", {
        url: "https://hooks.example.com/other", events: ["user.created"],
      }, "native-actor")).rejects.toBeInstanceOf(InvalidWebhookRecordError);
      const metadata: unknown = await database`SELECT id FROM project_webhooks`;
      expect(metadata).toEqual([{ id: created.id }]);
      const secretCount: unknown = await database`SELECT COUNT(*)::int AS count FROM project_control_secrets`;
      expect(secretCount).toEqual([{ count: 1 }]);
    } finally {
      if (previousKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
      else process.env.SECRETS_ENCRYPTION_KEY = previousKey;
    }
  }),
  40_000,
);
