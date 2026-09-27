import type { SQL } from "bun";
import { Value } from "typebox/value";
import {
  ApplicationConfigurationIdSchema, assertApplicationConfigurationScope,
  parseApplicationConfigurationWrite, parseApplicationConfigurationView,
  type ApplicationConfiguration, type ApplicationConfigurationScope,
  type ApplicationConfigurationView, type ApplicationReleaseRecord,
} from "@supacloud/delivery";
import { sql } from "../db";
import { encryptSecret, decryptSecret } from "../utils/secret-crypto";
import { stableSha256, stableStringify } from "../utils/stable-json";

export class ApplicationConfigurationError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}
interface ConfigurationRow {
  configuration_id: string;
  previous_configuration_id: string | null;
  request_fingerprint: string;
  encrypted_configuration: string;
  public_configuration: unknown;
  created_at: Date | string;
}

function summary(configuration: ApplicationConfiguration) {
  return {
    bun_version: configuration.bun_version,
    targets: configuration.targets.map(target => ({
      name: target.name, kind: target.kind, hosts: target.hosts,
      environment_names: Object.keys(target.environment).sort(),
    })),
  };
}

function view(scope: ApplicationConfigurationScope, row: ConfigurationRow): ApplicationConfigurationView {
  const publicData = row.public_configuration;
  if (!publicData || typeof publicData !== "object" || Array.isArray(publicData)) {
    throw new Error("APPLICATION_CONFIGURATION_CORRUPT");
  }
  return parseApplicationConfigurationView({
    ...publicData,
    schema: "supacloud.application-configuration.v1",
    project_ref: scope.projectRef, application_id: scope.applicationId, environment_id: scope.environmentId,
    configuration_id: row.configuration_id, created_at: new Date(row.created_at).toISOString(),
  });
}

/** Revisions are immutable; retrying an old write never resets the current head. */
export class ApplicationConfigurations {
  constructor(
    private readonly database: SQL = sql,
    private readonly crypto = { encrypt: encryptSecret, decrypt: decryptSecret },
  ) {}

  async put(scope: ApplicationConfigurationScope, candidate: unknown): Promise<ApplicationConfigurationView> {
    scope = structuredClone(scope);
    assertApplicationConfigurationScope(scope);
    let input;
    try { input = parseApplicationConfigurationWrite(candidate); }
    catch { throw new ApplicationConfigurationError("APPLICATION_CONFIGURATION_INVALID", 400); }
    const fingerprint = stableSha256({ scope, input });
    return this.database.begin(async transaction => {
      await transaction`SELECT pg_advisory_xact_lock(hashtextextended(${stableStringify({
        namespace: "application-configuration", ...scope,
      })}, 0))`;
      const existing = await this.readRow(transaction, scope, input.configuration_id);
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new ApplicationConfigurationError("APPLICATION_CONFIGURATION_ID_CONFLICT", 409);
        }
        return view(scope, existing);
      }
      const [head] = await transaction`
        SELECT configuration_id FROM application_configuration_heads
        WHERE project_ref = ${scope.projectRef} AND application_id = ${scope.applicationId}
          AND environment_id = ${scope.environmentId}
      `;
      if ((head?.configuration_id ?? null) !== input.expected_configuration_id) {
        throw new ApplicationConfigurationError("APPLICATION_CONFIGURATION_REVISION_CONFLICT", 409);
      }
      const encrypted = this.crypto.encrypt(stableStringify(input.configuration));
      const [row] = await transaction`
        INSERT INTO application_configuration_revisions
          (project_ref, application_id, environment_id, configuration_id, previous_configuration_id,
           request_fingerprint, encrypted_configuration, public_configuration)
        VALUES (${scope.projectRef}, ${scope.applicationId}, ${scope.environmentId}, ${input.configuration_id},
          ${input.expected_configuration_id}, ${fingerprint}, ${encrypted}, ${summary(input.configuration)}::jsonb)
        RETURNING *
      `;
      await transaction`
        INSERT INTO application_configuration_heads (project_ref, application_id, environment_id, configuration_id)
        VALUES (${scope.projectRef}, ${scope.applicationId}, ${scope.environmentId}, ${input.configuration_id})
        ON CONFLICT (project_ref, application_id, environment_id)
        DO UPDATE SET configuration_id = EXCLUDED.configuration_id
      `;
      return view(scope, row as ConfigurationRow);
    });
  }

  async read(scope: ApplicationConfigurationScope, configurationId?: string): Promise<ApplicationConfigurationView | null> {
    scope = structuredClone(scope);
    assertApplicationConfigurationScope(scope);
    const row = await this.readRow(this.database, scope, configurationId);
    return row ? view(scope, row) : null;
  }

  async resolve(scope: ApplicationConfigurationScope, configurationId: string, release: ApplicationReleaseRecord) {
    scope = structuredClone(scope);
    release = structuredClone(release);
    assertApplicationConfigurationScope(scope);
    if (!Value.Check(ApplicationConfigurationIdSchema, configurationId)) {
      throw new ApplicationConfigurationError("APPLICATION_CONFIGURATION_INVALID_ID", 400);
    }
    const row = await this.readRow(this.database, scope, configurationId);
    if (!row) throw new ApplicationConfigurationError("APPLICATION_CONFIGURATION_NOT_FOUND", 404);
    const input = parseApplicationConfigurationWrite({
      configuration_id: row.configuration_id, expected_configuration_id: row.previous_configuration_id,
      configuration: JSON.parse(this.crypto.decrypt(row.encrypted_configuration)),
    });
    if (stableSha256({ scope, input }) !== row.request_fingerprint
      || stableStringify(summary(input.configuration)) !== stableStringify(row.public_configuration)) {
      throw new Error("APPLICATION_CONFIGURATION_CORRUPT");
    }
    if (release.project_ref !== scope.projectRef || release.application_id !== scope.applicationId
      || release.targets.length !== input.configuration.targets.length
      || release.targets.some(target => !input.configuration.targets.some(config =>
        config.name === target.name && config.kind === target.kind))) {
      throw new ApplicationConfigurationError("APPLICATION_CONFIGURATION_TARGET_MISMATCH", 409);
    }
    return {
      bunVersion: input.configuration.bun_version,
      environment: Object.fromEntries(input.configuration.targets.map(target => [target.name, target.environment])),
      hosts: Object.fromEntries(input.configuration.targets.filter(target => target.kind === "http")
        .map(target => [target.name, target.hosts])),
    };
  }

  private async readRow(database: SQL, scope: ApplicationConfigurationScope, configurationId?: string) {
    if (configurationId !== undefined && !Value.Check(ApplicationConfigurationIdSchema, configurationId)) {
      throw new ApplicationConfigurationError("APPLICATION_CONFIGURATION_INVALID_ID", 400);
    }
    const [row] = configurationId === undefined
      ? await database`
          SELECT revision.* FROM application_configuration_heads head
          JOIN application_configuration_revisions revision USING
            (project_ref, application_id, environment_id, configuration_id)
          WHERE head.project_ref = ${scope.projectRef} AND head.application_id = ${scope.applicationId}
            AND head.environment_id = ${scope.environmentId}
        `
      : await database`
          SELECT * FROM application_configuration_revisions
          WHERE project_ref = ${scope.projectRef} AND application_id = ${scope.applicationId}
            AND environment_id = ${scope.environmentId} AND configuration_id = ${configurationId}
        `;
    return row as ConfigurationRow | undefined;
  }
}
