import path from "node:path";
import { lstat, readlink } from "node:fs/promises";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const text = Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+(?![\\s\\S])" });
const staticSchema = Type.Object({
  name: text, source: text, target: text, url: Type.Optional(text),
});
const ssrSchema = Type.Object({
  ...staticSchema.properties,
  service: text,
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});
const hooksSchema = Type.Object({
  pre_deploy: Type.Optional(text), post_deploy: Type.Optional(text), on_failure: Type.Optional(text),
});
const retentionSchema = Type.Object({
  keep_versions: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  auto_cleanup: Type.Optional(Type.Boolean()),
});
export const deployConfigSchema = Type.Object({
  app: text, tenant: text,
  static: Type.Optional(Type.Array(staticSchema)),
  ssr: Type.Optional(Type.Array(ssrSchema)),
  hooks: Type.Optional(hooksSchema),
  retention: Type.Optional(retentionSchema),
});
export const deployRequestSchema = Type.Object({
  app: text, tenant: text, artifact: Type.String({ minLength: 1, maxLength: 64 * 1024 * 1024 }), config: deployConfigSchema,
});
export type StaticDeployConfig = Static<typeof staticSchema>;
export type SSRDeployConfig = Static<typeof ssrSchema>;
export type DeployConfig = Static<typeof deployConfigSchema>;
export type HooksConfig = Static<typeof hooksSchema>;
export type RetentionConfig = Static<typeof retentionSchema>;
export type DeployRequest = Static<typeof deployRequestSchema>;

export class InvalidDeploymentRecordError extends Error {
  constructor() {
    super("Invalid deployment configuration or receipt");
    this.name = "InvalidDeploymentRecordError";
  }
}

export function isDeployVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{8}_[0-9]{6}(?:_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?(?![\s\S])/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  const hour = Number(value.slice(9, 11)), minute = Number(value.slice(11, 13)), second = Number(value.slice(13, 15));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

function assertTarget(target: string): void {
  if (!path.isAbsolute(target) || target === path.parse(target).root || path.normalize(target) !== target) {
    throw new InvalidDeploymentRecordError();
  }
}

function copyTarget(value: StaticDeployConfig): StaticDeployConfig {
  assertTarget(value.target);
  if (path.isAbsolute(value.source) || path.normalize(value.source) !== value.source
    || value.source.split(/[\\/]/).some(segment => segment === "..")) throw new InvalidDeploymentRecordError();
  if (value.url !== undefined) {
    let url: URL;
    try { url = new URL(value.url); } catch { throw new InvalidDeploymentRecordError(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new InvalidDeploymentRecordError();
  }
  return {
    name: value.name, source: value.source, target: value.target,
    ...(value.url === undefined ? {} : { url: value.url }),
  };
}

export function readDeployConfig(value: unknown): DeployConfig {
  let candidate: unknown = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate); } catch { throw new InvalidDeploymentRecordError(); }
  }
  if (!Value.Check(deployConfigSchema, candidate)) throw new InvalidDeploymentRecordError();
  const targets = new Set<string>();
  const staticTargets = candidate.static === undefined ? undefined : Array.from(candidate.static, target => {
    if (!Value.Check(staticSchema, target)) throw new InvalidDeploymentRecordError();
    if (targets.has(target.target)) throw new InvalidDeploymentRecordError();
    targets.add(target.target);
    return copyTarget(target);
  });
  const ssrTargets = candidate.ssr === undefined ? undefined : Array.from(candidate.ssr, target => {
    if (!Value.Check(ssrSchema, target) || targets.has(target.target)) throw new InvalidDeploymentRecordError();
    targets.add(target.target);
    if (!/^[A-Za-z0-9][A-Za-z0-9@_.:-]*(?![\s\S])/.test(target.service)) throw new InvalidDeploymentRecordError();
    const env = target.env === undefined ? undefined : Object.fromEntries(Object.entries(target.env));
    if (env && Object.entries(env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*(?![\s\S])/.test(key) || /[\0\r\n]/.test(value))) {
      throw new InvalidDeploymentRecordError();
    }
    return { ...copyTarget(target), service: target.service, ...(env === undefined ? {} : { env }) };
  });
  if (targets.size === 0) throw new InvalidDeploymentRecordError();
  return {
    app: candidate.app, tenant: candidate.tenant,
    ...(staticTargets === undefined ? {} : { static: staticTargets }),
    ...(ssrTargets === undefined ? {} : { ssr: ssrTargets }),
    ...(candidate.hooks === undefined ? {} : { hooks: {
      ...(candidate.hooks.pre_deploy === undefined ? {} : { pre_deploy: candidate.hooks.pre_deploy }),
      ...(candidate.hooks.post_deploy === undefined ? {} : { post_deploy: candidate.hooks.post_deploy }),
      ...(candidate.hooks.on_failure === undefined ? {} : { on_failure: candidate.hooks.on_failure }),
    } }),
    ...(candidate.retention === undefined ? {} : { retention: {
      ...(candidate.retention.keep_versions === undefined ? {} : { keep_versions: candidate.retention.keep_versions }),
      ...(candidate.retention.auto_cleanup === undefined ? {} : { auto_cleanup: candidate.retention.auto_cleanup }),
    } }),
  };
}

export function readDeployRequest(value: unknown): DeployRequest {
  if (!Value.Check(deployRequestSchema, value)) throw new InvalidDeploymentRecordError();
  const config = readDeployConfig(value.config);
  if (config.app !== value.app || config.tenant !== value.tenant
    || value.artifact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}(?![\s\S])/.test(value.artifact)
    || Buffer.from(value.artifact, "base64").toString("base64") !== value.artifact) {
    throw new InvalidDeploymentRecordError();
  }
  return { app: value.app, tenant: value.tenant, artifact: value.artifact, config };
}

const rowSchema = Type.Object({
  id: text, app: text, tenant: text, version: Type.String(),
  status: Type.Union([Type.Literal("success"), Type.Literal("failed"), Type.Literal("rolled_back")]),
  deployed_at: Type.Date(), triggered_by: text, config: Type.Unknown(),
});

export function readDeploymentRows(value: unknown, expected: { app?: string; version?: string; status?: string } = {}) {
  if (!Array.isArray(value)) throw new InvalidDeploymentRecordError();
  const ids = new Set<string>();
  return Array.from(value, (raw: unknown) => {
    if (!Value.Check(rowSchema, raw) || ids.has(raw.id)
      || (expected.app !== undefined && raw.app !== expected.app)
      || (expected.version !== undefined && raw.version !== expected.version)
      || (expected.status !== undefined && raw.status !== expected.status)
      || (raw.version === "" ? raw.status !== "failed" : !isDeployVersion(raw.version))) {
      throw new InvalidDeploymentRecordError();
    }
    ids.add(raw.id);
    const config = readDeployConfig(raw.config);
    if (config.app !== raw.app || config.tenant !== raw.tenant) throw new InvalidDeploymentRecordError();
    return {
      id: raw.id, appId: raw.app, tenant: raw.tenant, version: raw.version, status: raw.status,
      deployedAt: new Date(raw.deployed_at), triggeredBy: raw.triggered_by, config,
    };
  });
}
export type DeploymentHistory = ReturnType<typeof readDeploymentRows>[number];

export async function readPreviousDeployVersion(target: string): Promise<string | null> {
  assertTarget(target);
  let link: string;
  try { link = await readlink(target); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const resolved = path.resolve(path.dirname(target), link);
  const prefix = `${path.basename(target)}_`;
  const basename = path.basename(resolved);
  const version = basename.slice(prefix.length);
  if (path.dirname(resolved) !== path.dirname(target) || !basename.startsWith(prefix) || !isDeployVersion(version)) {
    throw new InvalidDeploymentRecordError();
  }
  if (!(await lstat(resolved)).isDirectory()) throw new InvalidDeploymentRecordError();
  return version;
}
