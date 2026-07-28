import type { SQL } from "bun";
import { canonicalAuthProviderLinkingConfig } from "../utils/provider-linking";
import { decryptSecretIfNeeded, encryptSecretIfNeeded } from "../utils/secret-crypto";
import { logger } from "../utils/logger";
import { webhookSigningSecretName } from "../utils/webhook-secret";
import {
  GOTRUE_USER_ID_POSTGRES_PATTERN,
  PROJECT_USER_LIFECYCLE_LOCK_NAMESPACE,
} from "../utils/project-user-lifecycle";
import { config } from "../config";
import { executeSqlStatements } from "./sql-statements";

function configuredAuthAuthoritySql(): { backfill: string; constant: string } {
  const authorityRef = config.authRuntimeOwnerRef.trim();
  if (!authorityRef) return { backfill: "project_ref", constant: "NULL" };
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(authorityRef)) {
    throw new Error("SUPACLOUD_AUTH_RUNTIME_OWNER_REF must be a valid project ref");
  }
  const literal = `'${authorityRef.replaceAll("'", "''")}'`;
  return { backfill: literal, constant: literal };
}

/**
 * Additive control-plane schema used by the SupaOAuth management facade.
 *
 * Authentication data (users, sessions, factors and OAuth grants) deliberately
 * remains in the tenant GoTrue database.  These tables only contain project
 * control-plane state and references to GoTrue/application identifiers.
 * The caller supplies the transaction so canonical init can keep adjacent
 * migrations inside the same atomic boundary.
 */
export async function ensurePlatformV2Schema(transaction: SQL): Promise<void> {
  const authAuthoritySql = configuredAuthAuthoritySql();
  await executeSqlStatements(transaction, `
    CREATE TABLE IF NOT EXISTS project_business_organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      name VARCHAR(120) NOT NULL,
      slug VARCHAR(120) NOT NULL,
      description TEXT,
      branding JSONB NOT NULL DEFAULT '{}'::jsonb,
      jit_enabled BOOLEAN NOT NULL DEFAULT false,
      jit_domains TEXT[] NOT NULL DEFAULT '{}'::text[],
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_ref, slug)
    );
    CREATE INDEX IF NOT EXISTS project_business_org_project_idx
      ON project_business_organizations(project_ref, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_business_organization_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES project_business_organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(organization_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS project_business_org_members_user_idx
      ON project_business_organization_members(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_business_organization_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES project_business_organizations(id) ON DELETE CASCADE,
      email VARCHAR(320) NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'member',
      token_hash VARCHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
      invited_by TEXT,
      accepted_user_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS project_business_org_invites_lookup_idx
      ON project_business_organization_invitations(organization_id, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS project_business_org_pending_invite_idx
      ON project_business_organization_invitations(organization_id, lower(email))
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS project_business_organization_applications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL REFERENCES project_business_organizations(id) ON DELETE CASCADE,
      application_id TEXT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(organization_id, application_id)
    );

    CREATE TABLE IF NOT EXISTS project_collaborators (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      principal_id TEXT NOT NULL,
      email VARCHAR(320),
      role VARCHAR(20) NOT NULL DEFAULT 'member'
        CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
      status VARCHAR(20) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'suspended')),
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_ref, principal_id)
    );
    CREATE INDEX IF NOT EXISTS project_collaborators_project_idx
      ON project_collaborators(project_ref, status, created_at ASC);

    CREATE TABLE IF NOT EXISTS project_collaborator_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      email VARCHAR(320) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'member'
        CHECK (role IN ('admin', 'member', 'viewer')),
      token_hash VARCHAR(64) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
      invited_by TEXT,
      accepted_principal_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS project_collaborator_invites_project_idx
      ON project_collaborator_invitations(project_ref, status, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS project_collaborator_pending_invite_idx
      ON project_collaborator_invitations(project_ref, lower(email))
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS project_control_secrets (
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      scope VARCHAR(24) NOT NULL
        CONSTRAINT project_control_secrets_scope_check
        CHECK (scope IN ('captcha', 'connector', 'auth-hook', 'webhook')),
      name VARCHAR(128) NOT NULL,
      value_encrypted TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_ref, scope, name)
    );
    CREATE INDEX IF NOT EXISTS project_control_secrets_scope_idx
      ON project_control_secrets(project_ref, scope, name);

    CREATE TABLE IF NOT EXISTS secret_encryption_checkpoints (
      scheme VARCHAR(20) NOT NULL,
      key_fingerprint VARCHAR(64) NOT NULL,
      rotated_count INTEGER NOT NULL CHECK (rotated_count >= 0),
      verified_count INTEGER NOT NULL CHECK (verified_count >= 0),
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (scheme, key_fingerprint)
    );

    CREATE TABLE IF NOT EXISTS platform_schema_migrations (
      migration_key TEXT PRIMARY KEY,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      details JSONB NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE IF NOT EXISTS supaoauth_bff_proof_nonces (
      nonce VARCHAR(128) PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS supaoauth_bff_proof_nonces_expiry_idx
      ON supaoauth_bff_proof_nonces(expires_at);

    CREATE TABLE IF NOT EXISTS project_user_deletion_fences (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'deleting', 'deleted', 'failed')),
      should_soft_delete BOOLEAN NOT NULL DEFAULT false,
      request_id TEXT NOT NULL,
      operation_id UUID NOT NULL DEFAULT gen_random_uuid(),
      operation_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
      last_error TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deletion_started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_ref, user_id)
    );
    ALTER TABLE project_user_deletion_fences ADD COLUMN IF NOT EXISTS operation_id UUID;
    ALTER TABLE project_user_deletion_fences ADD COLUMN IF NOT EXISTS operation_expires_at TIMESTAMPTZ;
    UPDATE project_user_deletion_fences
    SET operation_id = COALESCE(operation_id, gen_random_uuid()),
        operation_expires_at = COALESCE(operation_expires_at, updated_at + INTERVAL '5 minutes')
    WHERE operation_id IS NULL OR operation_expires_at IS NULL;
    ALTER TABLE project_user_deletion_fences ALTER COLUMN operation_id SET NOT NULL;
    ALTER TABLE project_user_deletion_fences ALTER COLUMN operation_id SET DEFAULT gen_random_uuid();
    ALTER TABLE project_user_deletion_fences ALTER COLUMN operation_expires_at SET NOT NULL;
    ALTER TABLE project_user_deletion_fences ALTER COLUMN operation_expires_at
      SET DEFAULT (NOW() + INTERVAL '5 minutes');
    CREATE INDEX IF NOT EXISTS project_user_deletion_fences_status_idx
      ON project_user_deletion_fences(project_ref, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS project_user_deletion_fences_operation_idx
      ON project_user_deletion_fences(operation_id);

    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS invoker_user_id UUID;
    ALTER TABLE project_tasks ADD COLUMN IF NOT EXISTS auth_authority_ref VARCHAR(20);
    UPDATE project_tasks
    SET invoker_user_id = BTRIM(payload->'auth'->>'invoker_user_id')::uuid
    WHERE invoker_user_id IS NULL
      AND BTRIM(payload->'auth'->>'invoker_user_id') ~* '${GOTRUE_USER_ID_POSTGRES_PATTERN}';
    UPDATE project_tasks
    SET auth_authority_ref = ${authAuthoritySql.backfill}
    WHERE auth_authority_ref IS NULL;
    ALTER TABLE project_tasks ALTER COLUMN auth_authority_ref SET NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_project_tasks_invoker_active
      ON project_tasks(project_ref, invoker_user_id, status)
      WHERE invoker_user_id IS NOT NULL
        AND status IN ('pending', 'leased', 'running', 'retry_scheduled');
    CREATE INDEX IF NOT EXISTS idx_project_tasks_authority_invoker_active
      ON project_tasks(auth_authority_ref, invoker_user_id, status)
      WHERE invoker_user_id IS NOT NULL
        AND status IN ('pending', 'leased', 'running', 'retry_scheduled');

    CREATE OR REPLACE FUNCTION enforce_project_user_deletion_fence() RETURNS trigger AS $$
    DECLARE
      configured_authority_ref TEXT := ${authAuthoritySql.constant};
      payload_invoker_user_id TEXT;
      normalized_payload_invoker_user_id UUID;
    BEGIN
      IF NEW.auth_authority_ref IS NULL THEN
        NEW.auth_authority_ref := COALESCE(configured_authority_ref, NEW.project_ref);
      ELSIF NEW.auth_authority_ref IS DISTINCT FROM COALESCE(configured_authority_ref, NEW.project_ref) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'TASK_AUTH_AUTHORITY_MISMATCH',
          DETAIL = 'project_tasks.auth_authority_ref must match the configured GoTrue authority';
      END IF;

      payload_invoker_user_id := NULLIF(BTRIM(NEW.payload->'auth'->>'invoker_user_id'), '');
      IF payload_invoker_user_id IS NULL THEN
        IF NEW.invoker_user_id IS NOT NULL THEN
          RAISE EXCEPTION USING
            ERRCODE = 'P0001',
            MESSAGE = 'TASK_INVOKER_MISMATCH',
            DETAIL = 'Authoritative invoker_user_id requires the same UUID in payload.auth';
        END IF;
        RETURN NEW;
      END IF;

      IF payload_invoker_user_id !~* '${GOTRUE_USER_ID_POSTGRES_PATTERN}' THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'TASK_INVOKER_MISMATCH',
          DETAIL = 'payload.auth.invoker_user_id must be a GoTrue UUID';
      END IF;

      normalized_payload_invoker_user_id := payload_invoker_user_id::uuid;
      IF NEW.invoker_user_id IS NULL THEN
        NEW.invoker_user_id := normalized_payload_invoker_user_id;
      ELSIF NEW.invoker_user_id IS DISTINCT FROM normalized_payload_invoker_user_id THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'TASK_INVOKER_MISMATCH',
          DETAIL = 'project_tasks.invoker_user_id must match payload.auth.invoker_user_id';
      END IF;

      IF NEW.status NOT IN ('pending', 'leased', 'running', 'retry_scheduled') THEN
        RETURN NEW;
      END IF;

      PERFORM pg_advisory_xact_lock(hashtextextended(
        '${PROJECT_USER_LIFECYCLE_LOCK_NAMESPACE}:' || NEW.auth_authority_ref || ':' || NEW.invoker_user_id::text,
        0
      ));

      IF EXISTS (
        SELECT 1
        FROM project_user_deletion_fences
        WHERE project_ref = NEW.auth_authority_ref
          AND user_id = NEW.invoker_user_id
          AND status IN ('requested', 'deleting', 'deleted')
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'P0001',
          MESSAGE = 'USER_DELETION_FENCED',
          DETAIL = 'Tasks cannot be activated after GoTrue user deletion has been requested';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS project_tasks_user_deletion_fence ON project_tasks;
    CREATE TRIGGER project_tasks_user_deletion_fence
      BEFORE INSERT OR UPDATE OF status, payload, project_ref, invoker_user_id, auth_authority_ref ON project_tasks
      FOR EACH ROW EXECUTE FUNCTION enforce_project_user_deletion_fence();

    CREATE TABLE IF NOT EXISTS project_webhooks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      legacy_id TEXT,
      url TEXT NOT NULL,
      events TEXT[] NOT NULL,
      secret_encrypted TEXT,
      previous_secret_encrypted TEXT,
      secret_version INTEGER NOT NULL DEFAULT 1,
      enabled BOOLEAN NOT NULL DEFAULT true,
      api_version VARCHAR(20) NOT NULL DEFAULT '2026-07-01',
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at TIMESTAMPTZ,
      UNIQUE(project_ref, legacy_id)
    );
    ALTER TABLE project_webhooks ALTER COLUMN secret_encrypted DROP NOT NULL;
    ALTER TABLE project_webhooks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE project_control_secrets DROP CONSTRAINT IF EXISTS project_control_secrets_scope_check;
    ALTER TABLE project_control_secrets ADD CONSTRAINT project_control_secrets_scope_check
      CHECK (scope IN ('captcha', 'connector', 'auth-hook', 'webhook'));
    CREATE INDEX IF NOT EXISTS project_webhooks_project_idx
      ON project_webhooks(project_ref, created_at ASC);
    CREATE INDEX IF NOT EXISTS project_webhooks_active_idx
      ON project_webhooks(project_ref, created_at ASC)
      WHERE deleted_at IS NULL;

    CREATE TABLE IF NOT EXISTS webhook_outbox (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      webhook_id UUID NOT NULL REFERENCES project_webhooks(id) ON DELETE CASCADE,
      event_id UUID NOT NULL DEFAULT gen_random_uuid(),
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      api_version VARCHAR(20) NOT NULL DEFAULT '2026-07-01',
      idempotency_key TEXT,
      status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivering', 'retry_scheduled', 'delivered', 'dead_lettered', 'cancelled')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      locked_at TIMESTAMPTZ,
      last_error TEXT,
      replay_of_delivery_id UUID,
      replay_request_body TEXT,
      replay_signature_timestamp TEXT,
      replay_secret_version INTEGER,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS webhook_outbox_idempotency_idx
      ON webhook_outbox(project_ref, webhook_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS webhook_outbox_ready_idx
      ON webhook_outbox(status, next_attempt_at, created_at)
      WHERE status IN ('pending', 'retry_scheduled');

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      outbox_id UUID NOT NULL REFERENCES webhook_outbox(id) ON DELETE CASCADE,
      project_ref VARCHAR(20) NOT NULL REFERENCES projects(ref) ON DELETE CASCADE,
      webhook_id UUID NOT NULL REFERENCES project_webhooks(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL,
      status VARCHAR(24) NOT NULL
        CHECK (status IN ('delivered', 'failed', 'dead_lettered')),
      status_code INTEGER,
      error TEXT,
      response_preview TEXT,
      request_bytes INTEGER,
      request_body TEXT,
      signature_timestamp TEXT,
      request_api_version VARCHAR(20),
      signature_version VARCHAR(20) NOT NULL DEFAULT 'v1',
      secret_version INTEGER NOT NULL DEFAULT 1,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(outbox_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS webhook_deliveries_lookup_idx
      ON webhook_deliveries(project_ref, webhook_id, created_at DESC);

    ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS api_version VARCHAR(20) NOT NULL DEFAULT '2026-07-01';
    ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS replay_request_body TEXT;
    ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS replay_signature_timestamp TEXT;
    ALTER TABLE webhook_outbox ADD COLUMN IF NOT EXISTS replay_secret_version INTEGER;
    ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS request_body TEXT;
    ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS signature_timestamp TEXT;
    ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS request_api_version VARCHAR(20);
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'management-api';
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_type TEXT NOT NULL DEFAULT 'system';
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS previous_hash TEXT;
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS event_hash TEXT;
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS chain_sequence BIGINT;
    CREATE INDEX IF NOT EXISTS audit_logs_project_hash_idx
      ON audit_logs(project_ref, created_at DESC, id);
    CREATE INDEX IF NOT EXISTS audit_logs_project_sequence_idx
      ON audit_logs(project_ref, chain_sequence ASC)
      WHERE chain_sequence IS NOT NULL;

    CREATE TABLE IF NOT EXISTS audit_log_checkpoints (
      project_ref VARCHAR(50) PRIMARY KEY,
      last_event_id UUID,
      last_event_hash TEXT,
      event_count BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_exports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_ref VARCHAR(50) NOT NULL,
      actor TEXT NOT NULL,
      format VARCHAR(16) NOT NULL DEFAULT 'jsonl' CHECK (format IN ('jsonl', 'csv')),
      filters JSONB NOT NULL DEFAULT '{}'::jsonb,
      status VARCHAR(16) NOT NULL DEFAULT 'completed'
        CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
      row_count INTEGER NOT NULL DEFAULT 0,
      checksum TEXT,
      checkpoint_hash TEXT,
      content TEXT,
      error TEXT,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS audit_exports_project_idx
      ON audit_exports(project_ref, created_at DESC);

    CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_logs is append-only';
    END;
    $$ LANGUAGE plpgsql;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'audit_logs'::regclass
          AND tgname = 'audit_logs_append_only'
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER audit_logs_append_only
          BEFORE UPDATE OR DELETE ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
      END IF;
    END;
    $$;
  `);

  await transaction`
    INSERT INTO project_collaborators (project_ref, principal_id, role, created_by)
    SELECT DISTINCT p.ref, o.owner_id, 'owner', 'platform-migration'
    FROM projects p
    JOIN organizations o ON o.id = p.organization_id
    JOIN organization_members owner_member
      ON owner_member.organization_id = o.id
     AND owner_member.user_id = o.owner_id
    WHERE p.deleted_at IS NULL
      AND NULLIF(o.owner_id, '') IS NOT NULL
    ON CONFLICT (project_ref, principal_id) DO NOTHING
  `;
}

export async function ensurePlatformV2SchemaInTransaction(controlPlaneDb: SQL): Promise<void> {
  await controlPlaneDb.begin(async (transaction) => ensurePlatformV2Schema(transaction));
}

type LegacyWebhook = {
  id?: unknown;
  url?: unknown;
  events?: unknown;
  secret?: unknown;
  enabled?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

type MigratedLegacyWebhook = {
  legacyId: string;
  url: string;
  events: string[];
  secret: string;
  enabled: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
};

type DeprecatedWebhookSecretRow = {
  id: string;
  project_ref: string;
  secret_encrypted: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configObject(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function strictConfigObject(value: unknown, location: string): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (isRecord(value)) return structuredClone(value);
  if (typeof value !== "string") throw new Error(`${location} must be a JSON object`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: unknown) {
    throw new Error(`${location} contains invalid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) throw new Error(`${location} must decode to a JSON object`);
  return parsed;
}

function canonicalProviderLinkingProjectConfig(
  rawConfig: unknown,
  projectRef: string,
): Record<string, unknown> | null {
  const config = strictConfigObject(rawConfig, `projects.config[${projectRef}]`);
  if (!config || !("auth" in config)) return null;
  const auth = strictConfigObject(config.auth, `projects.config.auth[${projectRef}]`);
  if (!auth || !("experimental" in auth)) return null;
  const experimental = strictConfigObject(
    auth.experimental,
    `projects.config.auth.experimental[${projectRef}]`,
  );
  if (!experimental || !("providers_with_own_linking_domain" in experimental)) return null;
  config.auth = canonicalAuthProviderLinkingConfig({ ...auth, experimental });
  return config;
}

export async function migrateLegacyProviderLinkingConfig(db: SQL): Promise<number> {
  const projects = await db`
    SELECT ref, config
    FROM projects
    WHERE deleted_at IS NULL
  ` as Array<{ ref: string; config: unknown }>;
  let migrated = 0;
  for (const project of projects) {
    const config = canonicalProviderLinkingProjectConfig(project.config, project.ref);
    if (!config) continue;
    await db`
      UPDATE projects
      SET config = ${config}::jsonb, updated_at = NOW()
      WHERE ref = ${project.ref}
    `;
    migrated += 1;
  }
  if (migrated > 0) logger.info(`[PlatformV2] Migrated provider linking config for ${migrated} project(s)`);
  return migrated;
}

function normalizedLegacyWebhook(rawWebhook: LegacyWebhook): MigratedLegacyWebhook | null {
  if (!isRecord(rawWebhook) || typeof rawWebhook.url !== "string" || !rawWebhook.url.trim()) return null;
  const events = Array.isArray(rawWebhook.events)
    ? rawWebhook.events.map((eventName) => String(eventName).trim()).filter(Boolean)
    : [];
  if (events.length === 0) return null;
  return {
    legacyId: typeof rawWebhook.id === "string" && rawWebhook.id.trim()
      ? rawWebhook.id.trim()
      : crypto.randomUUID(),
    url: rawWebhook.url.trim(),
    events,
    secret: typeof rawWebhook.secret === "string" && rawWebhook.secret
      ? rawWebhook.secret
      : `whsec_${crypto.randomUUID().replaceAll("-", "")}`,
    enabled: rawWebhook.enabled !== false,
    createdAt: typeof rawWebhook.created_at === "string" ? rawWebhook.created_at : new Date(),
    updatedAt: typeof rawWebhook.updated_at === "string" ? rawWebhook.updated_at : new Date(),
  };
}

async function persistLegacyWebhook(db: SQL, projectRef: string, webhook: MigratedLegacyWebhook): Promise<void> {
  const webhookId = crypto.randomUUID();
  const [storedWebhook] = await db`
    INSERT INTO project_webhooks (
      id, project_ref, legacy_id, url, events, enabled, created_at, updated_at
    ) VALUES (
      ${webhookId}, ${projectRef}, ${webhook.legacyId}, ${webhook.url}, ${webhook.events},
      ${webhook.enabled}, ${webhook.createdAt}, ${webhook.updatedAt}
    )
    ON CONFLICT (project_ref, legacy_id) DO UPDATE SET legacy_id = EXCLUDED.legacy_id
    RETURNING id
  `;
  await db`
    INSERT INTO project_control_secrets (project_ref, scope, name, value_encrypted)
    VALUES (
      ${projectRef}, 'webhook', ${webhookSigningSecretName(String(storedWebhook.id))},
      ${encryptSecretIfNeeded(webhook.secret)}
    )
    ON CONFLICT (project_ref, scope, name) DO NOTHING
  `;
}

/** Move old config-embedded webhook definitions into durable metadata and managed secret storage. */
export async function migrateLegacyProjectWebhooks(db: SQL): Promise<number> {
  const projects = await db`
    SELECT ref, config
    FROM projects
    WHERE deleted_at IS NULL
  ` as Array<{ ref: string; config: unknown }>;
  let migrated = 0;

  for (const project of projects) {
    const config = configObject(project.config);
    if (!config) continue;
    const rawWebhooks = config.webhooks;
    if (!Array.isArray(rawWebhooks)) continue;

    for (const rawWebhook of rawWebhooks as LegacyWebhook[]) {
      const webhook = normalizedLegacyWebhook(rawWebhook);
      if (!webhook) continue;
      await persistLegacyWebhook(db, project.ref, webhook);
      migrated += 1;
    }

    // Do not leave webhook credentials in the generic project JSON blob.
    const nextConfig = structuredClone(config);
    delete nextConfig.webhooks;
    delete nextConfig.webhook_delivery_logs;
    await db`
      UPDATE projects
      SET config = ${nextConfig}::jsonb, updated_at = NOW()
      WHERE ref = ${project.ref}
    `;
  }

  if (migrated > 0) logger.info(`[PlatformV2] Migrated ${migrated} legacy webhook definition(s)`);
  return migrated;
}

async function migrateDeprecatedWebhookSecret(db: SQL, webhookSecret: DeprecatedWebhookSecretRow): Promise<void> {
  const secret = decryptSecretIfNeeded(webhookSecret.secret_encrypted);
  await db`
    INSERT INTO project_control_secrets (project_ref, scope, name, value_encrypted)
    VALUES (
      ${webhookSecret.project_ref}, 'webhook', ${webhookSigningSecretName(String(webhookSecret.id))},
      ${encryptSecretIfNeeded(secret)}
    )
    ON CONFLICT (project_ref, scope, name) DO NOTHING
  `;
  await db`
    UPDATE project_webhooks
    SET secret_encrypted = NULL, previous_secret_encrypted = NULL, updated_at = NOW()
    WHERE id = ${webhookSecret.id}
  `;
}

/**
 * Forward-only migration from the deprecated webhook columns into the managed
 * secret store. Existing columns remain nullable so rollback never drops data structures.
 */
export async function migrateWebhookSecretsToControlStore(db: SQL): Promise<number> {
  const rows = await db`
    SELECT id, project_ref, secret_encrypted
    FROM project_webhooks
    WHERE secret_encrypted IS NOT NULL
  ` as DeprecatedWebhookSecretRow[];
  for (const webhookSecret of rows) await migrateDeprecatedWebhookSecret(db, webhookSecret);
  if (rows.length > 0) logger.info(`[PlatformV2] Migrated ${rows.length} webhook signing secret(s) into managed storage`);
  return rows.length;
}

function legacySecretValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && trimmed !== "********" && trimmed !== "****" ? value : null;
  }
  if (value && typeof value === "object") return JSON.stringify(value);
  return null;
}

async function persistControlSecret(
  db: SQL,
  projectRef: string,
  scope: "captcha" | "connector" | "auth-hook",
  name: string,
  value: unknown,
): Promise<boolean> {
  const secret = legacySecretValue(value);
  if (!secret) return false;
  await db`
    INSERT INTO project_control_secrets (project_ref, scope, name, value_encrypted)
    VALUES (${projectRef}, ${scope}, ${name}, ${encryptSecretIfNeeded(secret)})
    ON CONFLICT (project_ref, scope, name) DO NOTHING
  `;
  return true;
}

/**
 * One-way migration for credentials previously embedded in projects.config.
 * The encrypted store becomes authoritative; non-secret provider/hook settings
 * remain in config so existing GoTrue management flows stay compatible.
 */
export async function migrateLegacyControlSecrets(db: SQL): Promise<number> {
  const projects = await db`
    SELECT ref, config
    FROM projects
    WHERE deleted_at IS NULL
  ` as Array<{ ref: string; config: unknown }>;
  let migrated = 0;

  for (const project of projects) {
    const parsedConfig = configObject(project.config);
    if (!parsedConfig) continue;
    const nextConfig = structuredClone(parsedConfig);
    const auth = isRecord(nextConfig.auth) ? nextConfig.auth : null;
    if (!auth) continue;
    let changed = false;

    const external = isRecord(auth.external) ? auth.external : null;
    if (external) {
      for (const [provider, rawProvider] of Object.entries(external)) {
        if (!isRecord(rawProvider) || !("client_secret" in rawProvider)) continue;
        if (await persistControlSecret(db, project.ref, "connector", provider, rawProvider.client_secret)) {
          migrated += 1;
        }
        delete rawProvider.client_secret;
        changed = true;
      }
    }

    if ("security_captcha_secret" in auth) {
      const provider = typeof auth.security_captcha_provider === "string"
        ? auth.security_captcha_provider.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-")
        : "default";
      if (await persistControlSecret(db, project.ref, "captcha", provider || "default", auth.security_captcha_secret)) {
        migrated += 1;
      }
      delete auth.security_captcha_secret;
      changed = true;
    }

    const hooks = isRecord(auth.hooks) ? auth.hooks : null;
    if (hooks) {
      for (const [hookName, rawHook] of Object.entries(hooks)) {
        if (!isRecord(rawHook) || !("secrets" in rawHook)) continue;
        if (await persistControlSecret(db, project.ref, "auth-hook", hookName, rawHook.secrets)) {
          migrated += 1;
        }
        delete rawHook.secrets;
        changed = true;
      }
    }

    if (changed) {
      await db`
        UPDATE projects
        SET config = ${nextConfig}::jsonb, updated_at = NOW()
        WHERE ref = ${project.ref}
      `;
    }
  }

  if (migrated > 0) logger.info(`[PlatformV2] Migrated ${migrated} legacy control secret(s)`);
  return migrated;
}
