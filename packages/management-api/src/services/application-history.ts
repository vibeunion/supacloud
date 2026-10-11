import type { SQL } from "bun";
import { Value } from "typebox/value";
import {
  ApplicationActivationHistoryPositionSchema, assertApplicationConfigurationScope,
  applicationHistoryCursor, applicationHistoryPositionBefore, applicationHistoryTimestampMilliseconds,
  parseApplicationActivationHistory, parseApplicationHistoryCursor,
  type ApplicationActivationHistory, type ApplicationActivationHistoryPosition, type ApplicationConfigurationScope,
} from "@supacloud/delivery";
import { sql } from "../db";
import { ApplicationActiveStorage } from "./application-active-storage";
import {
  applicationActivationMutations, parseApplicationActiveRecord, parseSuccessfulApplicationActivation,
  type ApplicationActivationMutations,
} from "./application-activation";
import { projectMutationResourceKey } from "./project-mutation.service";
import { stableSha256, stableStringify } from "../utils/stable-json";

export class ApplicationHistoryError extends Error {
  constructor(readonly code: string, readonly statusCode: number) { super(code); }
}

interface HistoryPage { cursor?: string; limit?: number }
interface Query {
  scope: ApplicationConfigurationScope;
  before: ApplicationActivationHistoryPosition | null;
  limit: number;
}
interface Dependencies {
  active?: Pick<ApplicationActiveStorage, "readForApplication">;
  mutations?: Pick<ApplicationActivationMutations, "read">;
  query?: (input: Query) => Promise<ApplicationActivationHistoryPosition[]>;
}

export async function queryApplicationActivationHistory(
  input: Query, database: SQL = sql,
): Promise<ApplicationActivationHistoryPosition[]> {
  try {
    assertApplicationConfigurationScope(input.scope);
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 101) throw new Error();
    if (input.before !== null) {
      if (!Value.Check(ApplicationActivationHistoryPositionSchema, input.before)) throw new Error();
      applicationHistoryTimestampMilliseconds(input.before.completed_at);
    }
  } catch { throw new ApplicationHistoryError("APPLICATION_HISTORY_PAGE_INVALID", 400); }
  const resourceKey = projectMutationResourceKey({
    type: "application_release",
    id: stableSha256({ applicationId: input.scope.applicationId, environmentId: input.scope.environmentId }),
  });
  const beforeTime = input.before?.completed_at ?? null, beforeId = input.before?.activation_id ?? null;
  return await database`
    SELECT mutation_id::text AS activation_id,
      to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at
    FROM project_mutations
    WHERE project_ref = ${input.scope.projectRef} AND resource_key = ${resourceKey}
      AND operation = 'application.release.activate' AND status = 'succeeded'
      AND completed_at IS NOT NULL
      AND (${beforeTime}::timestamptz IS NULL
        OR (completed_at, mutation_id) < (${beforeTime}::timestamptz, ${beforeId}::uuid))
    ORDER BY completed_at DESC, mutation_id DESC
    LIMIT ${input.limit}
  `;
}

export class ApplicationActivationHistoryReader {
  private readonly active: Pick<ApplicationActiveStorage, "readForApplication">;
  private readonly mutations: Pick<ApplicationActivationMutations, "read">;
  private readonly query: NonNullable<Dependencies["query"]>;

  constructor(dependencies: Dependencies = {}) {
    this.active = dependencies.active ?? new ApplicationActiveStorage();
    this.mutations = dependencies.mutations ?? applicationActivationMutations;
    this.query = dependencies.query ?? queryApplicationActivationHistory;
  }

  async read(input: ApplicationConfigurationScope, page: HistoryPage = {}): Promise<ApplicationActivationHistory> {
    const scope = structuredClone(input), limit = page.limit ?? 20;
    const publicScope = {
      project_ref: scope.projectRef, application_id: scope.applicationId, environment_id: scope.environmentId,
    };
    let before: ApplicationActivationHistoryPosition | null;
    try {
      assertApplicationConfigurationScope(scope);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page size");
      before = page.cursor === undefined ? null : parseApplicationHistoryCursor(page.cursor, publicScope);
    } catch { throw new ApplicationHistoryError("APPLICATION_HISTORY_PAGE_INVALID", 400); }
    try {
      const readActive = () => this.active.readForApplication(scope.projectRef, scope.applicationId, scope.environmentId);
      const observed = await readActive();
      const current = observed === null ? null : parseApplicationActiveRecord(observed, {
        release: { project_ref: scope.projectRef, application_id: scope.applicationId },
        environmentId: scope.environmentId,
      });
      const query = { scope, before, limit: limit + 1 };
      const rows = structuredClone(await this.query(query));
      if (!Array.isArray(rows) || rows.length > query.limit) throw new Error("Invalid journal page");
      const seen = new Set<string>();
      let last = before;
      const activations: ApplicationActivationHistory["activations"] = [];
      const states = new Map<string, Awaited<ReturnType<ApplicationActivationMutations["read"]>>>();
      for (const row of rows) {
        if (!Value.Check(ApplicationActivationHistoryPositionSchema, row)
          || seen.has(row.activation_id) || (last && !applicationHistoryPositionBefore(row, last))) {
          throw new Error("Invalid journal page");
        }
        seen.add(row.activation_id);
        last = row;
        const state = await this.mutations.read(scope.projectRef, row.activation_id);
        states.set(row.activation_id, structuredClone(state));
        const { desired, previous } = parseSuccessfulApplicationActivation(state, scope);
        if (state?.mutationId !== row.activation_id
          || state.completedAt !== applicationHistoryTimestampMilliseconds(row.completed_at)) {
          throw new Error("Invalid journal completion");
        }
        if (row.activation_id === current?.runtime.activationId && stableStringify(desired) !== stableStringify(current)) {
          throw new Error("Invalid active journal");
        }
        if (activations.length < limit) activations.push({
          ...row, release_id: desired.runtime.release.release_id, configuration_id: desired.configurationId ?? null,
          previous_activation_id: previous?.runtime.activationId ?? null,
          is_active: row.activation_id === current?.runtime.activationId,
        });
      }
      for (const [id, state] of states) {
        if (stableStringify(await this.mutations.read(scope.projectRef, id)) !== stableStringify(state)) {
          throw new ApplicationHistoryError("APPLICATION_HISTORY_CHANGED", 409);
        }
      }
      if (stableStringify(await this.query(query)) !== stableStringify(rows)
        || stableStringify(await readActive()) !== stableStringify(current)) {
        throw new ApplicationHistoryError("APPLICATION_HISTORY_CHANGED", 409);
      }
      const tail = activations.at(-1);
      return parseApplicationActivationHistory({
        schema: "supacloud.application-activation-history.v1", ...publicScope,
        active_activation_id: current?.runtime.activationId ?? null, activations,
        next_cursor: rows.length > limit && tail ? applicationHistoryCursor(publicScope, {
          completed_at: tail.completed_at, activation_id: tail.activation_id,
        }) : null,
      });
    } catch (error) {
      if (error instanceof ApplicationHistoryError) throw error;
      throw new ApplicationHistoryError("APPLICATION_HISTORY_UNVERIFIED", 503);
    }
  }
}
