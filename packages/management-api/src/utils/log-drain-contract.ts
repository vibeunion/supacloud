import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { isRecord } from "./project-config";

export const logDrainTypeSchema = Type.Union([
  Type.Literal("webhook"), Type.Literal("datadog"), Type.Literal("loki"), Type.Literal("elasticsearch"),
]);
export const logDrainTokenSchema = Type.String({ pattern: "^[^\\r\\n\\u0000]*$" });
export const logDrainSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  type: logDrainTypeSchema,
  url: Type.String({ minLength: 1 }),
  token: Type.Optional(logDrainTokenSchema),
  enabled: Type.Boolean(),
});
export type LogDrainType = Static<typeof logDrainTypeSchema>;
export type LogDrainConfig = Static<typeof logDrainSchema>;

export class InvalidLogDrainConfig extends Error {
  constructor() {
    super("Invalid stored log drain configuration");
    this.name = "InvalidLogDrainConfig";
  }
}

export function readLogDrains(projectConfig: unknown): LogDrainConfig[] {
  let config = projectConfig;
  if (typeof config === "string") {
    try { config = JSON.parse(config); } catch { throw new InvalidLogDrainConfig(); }
  }
  if (config === null || config === undefined) return [];
  if (!isRecord(config)) throw new InvalidLogDrainConfig();
  const raw = config.log_drains;
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new InvalidLogDrainConfig();
  const entries: unknown[] = raw;
  const ids = new Set<string>();
  return Array.from(entries, (entry) => {
    if (!Value.Check(logDrainSchema, entry) || ids.has(entry.id) || !entry.name.trim()) {
      throw new InvalidLogDrainConfig();
    }
    ids.add(entry.id);
    return {
      id: entry.id, name: entry.name, type: entry.type, url: entry.url, enabled: entry.enabled,
      ...(entry.token === undefined ? {} : { token: entry.token }),
    };
  });
}

export function sanitizeLogDrain(drain: LogDrainConfig): LogDrainConfig {
  const token = drain.token?.trim();
  return {
    id: drain.id, name: drain.name.trim().slice(0, 120), type: drain.type, url: drain.url, enabled: drain.enabled,
    ...(token ? { token } : {}),
  };
}

export function publicLogDrain(drain: LogDrainConfig): LogDrainConfig & { has_token: boolean } {
  const { token, ...publicFields } = drain;
  return { ...publicFields, has_token: !!token, ...(token ? { token: "********" } : {}) };
}
