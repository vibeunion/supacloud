import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { ApplicationActivationIdSchema } from "./application-activation";
import { ApplicationConfigurationIdSchema } from "./application-configuration";
import { ApplicationIdSchema, ApplicationReleaseIdSchema } from "./application-release";

const scope = {
  project_ref: Type.String({ pattern: "^[a-z0-9-]{1,20}$" }),
  application_id: ApplicationIdSchema, environment_id: ApplicationIdSchema,
};
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z$" });
export const ApplicationActivationHistoryPositionSchema = Type.Object({
  completed_at: timestamp, activation_id: ApplicationActivationIdSchema,
}, { additionalProperties: false });
const cursorSchema = Type.Object({
  ...scope, ...ApplicationActivationHistoryPositionSchema.properties,
}, { additionalProperties: false });
export const ApplicationActivationHistoryCursorSchema = Type.String({
  pattern: "^[A-Za-z0-9_-]+$", maxLength: 1024, minLength: 1,
});
const entrySchema = Type.Object({
  ...ApplicationActivationHistoryPositionSchema.properties,
  release_id: ApplicationReleaseIdSchema,
  configuration_id: Type.Union([ApplicationConfigurationIdSchema, Type.Null()]),
  previous_activation_id: Type.Union([ApplicationActivationIdSchema, Type.Null()]),
  is_active: Type.Boolean(),
}, { additionalProperties: false });
export const ApplicationActivationHistorySchema = Type.Object({
  schema: Type.Literal("supacloud.application-activation-history.v1"),
  ...scope,
  active_activation_id: Type.Union([ApplicationActivationIdSchema, Type.Null()]),
  activations: Type.Array(entrySchema, { maxItems: 100 }),
  next_cursor: Type.Union([ApplicationActivationHistoryCursorSchema, Type.Null()]),
}, { additionalProperties: false });
export type ApplicationActivationHistory = Static<typeof ApplicationActivationHistorySchema>;
export type ApplicationActivationHistoryPosition = Static<typeof ApplicationActivationHistoryPositionSchema>;
type HistoryScope = Pick<ApplicationActivationHistory, "project_ref" | "application_id" | "environment_id">;

export function applicationHistoryTimestampMilliseconds(value: string): string {
  const milliseconds = `${value.slice(0, 23)}Z`;
  if (!Value.Check(timestamp, value) || !Number.isFinite(Date.parse(milliseconds))
    || new Date(milliseconds).toISOString() !== milliseconds) throw new Error("Invalid application history timestamp");
  return milliseconds;
}

export function applicationHistoryCursor(scope: HistoryScope, position: ApplicationActivationHistoryPosition): string {
  const cursor = {
    project_ref: scope.project_ref, application_id: scope.application_id, environment_id: scope.environment_id,
    completed_at: position.completed_at, activation_id: position.activation_id,
  };
  if (!Value.Check(cursorSchema, cursor)) throw new Error("Invalid application history cursor");
  applicationHistoryTimestampMilliseconds(cursor.completed_at);
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function parseApplicationHistoryCursor(value: string, scope: HistoryScope): ApplicationActivationHistoryPosition {
  if (!Value.Check(ApplicationActivationHistoryCursorSchema, value)) throw new Error("Invalid application history cursor");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("Invalid application history cursor");
  const cursor: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Value.Check(cursorSchema, cursor) || cursor.project_ref !== scope.project_ref
    || cursor.application_id !== scope.application_id || cursor.environment_id !== scope.environment_id) {
    throw new Error("Invalid application history cursor");
  }
  applicationHistoryTimestampMilliseconds(cursor.completed_at);
  return { completed_at: cursor.completed_at, activation_id: cursor.activation_id };
}

export function applicationHistoryPositionBefore(
  left: ApplicationActivationHistoryPosition, right: ApplicationActivationHistoryPosition,
): boolean {
  return left.completed_at < right.completed_at
    || (left.completed_at === right.completed_at && left.activation_id < right.activation_id);
}

export function parseApplicationActivationHistory(value: unknown): ApplicationActivationHistory {
  if (!Value.Check(ApplicationActivationHistorySchema, value)) throw new Error("Invalid application activation history");
  const seen = new Set<string>();
  let previous: ApplicationActivationHistoryPosition | undefined;
  for (const entry of value.activations) {
    applicationHistoryTimestampMilliseconds(entry.completed_at);
    if (seen.has(entry.activation_id) || (previous && !applicationHistoryPositionBefore(entry, previous))
      || entry.previous_activation_id === entry.activation_id
      || entry.is_active !== (entry.activation_id === value.active_activation_id)) {
      throw new Error("Invalid application activation history");
    }
    seen.add(entry.activation_id);
    previous = entry;
  }
  if (value.next_cursor !== null) {
    const cursor = parseApplicationHistoryCursor(value.next_cursor, value);
    if (!previous || cursor.activation_id !== previous.activation_id || cursor.completed_at !== previous.completed_at) {
      throw new Error("Invalid application activation history");
    }
  }
  return structuredClone(value);
}
