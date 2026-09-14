import { FRONTEND_FRAMEWORKS, type DeployToken, type FrontendDeployment, type FrontendDeploymentConfig } from "../types/frontend";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const MAX_FRONTEND_DEPLOYMENT_BYTES = 8 * 1024 * 1024;

export function serializeFrontendDeployment(deployment: FrontendDeployment): string {
  const serialized = JSON.stringify(deployment, null, 2);
  if (Buffer.byteLength(serialized) > MAX_FRONTEND_DEPLOYMENT_BYTES) {
    throw new Error("Frontend deployment metadata exceeds the byte limit");
  }
  return serialized;
}

export class FrontendDeploymentReadError extends Error {
  constructor() {
    super("Unable to read a valid frontend deployment");
    this.name = "FrontendDeploymentReadError";
  }
}
function invalid(): never { throw new FrontendDeploymentReadError(); }

export async function readFrontendDeploymentFile(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FRONTEND_DEPLOYMENT_BYTES) return invalid();
    const buffer = Buffer.alloc(64 * 1024);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let text = "";
    for (;;) {
      const remaining = MAX_FRONTEND_DEPLOYMENT_BYTES - bytes;
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, remaining + 1), null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > MAX_FRONTEND_DEPLOYMENT_BYTES) return invalid();
      text += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    return value;
  } finally {
    await file.close();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return invalid();
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(value)) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !property || !("value" in property) || !property.enumerable) return invalid();
    entries.push([key, property.value]);
  }
  return Object.fromEntries(entries);
}
function text(value: unknown): string {
  return typeof value === "string" ? value : invalid();
}

export function parseFrontendBuildConfiguration(value: unknown) {
  const data = record(value);
  const keys = ["build_command", "output_dir", "install_command", "node_version", "health_check_path"];
  if (Object.keys(data).length !== keys.length || keys.some(key => !Object.hasOwn(data, key))) return invalid();
  const field = (value: unknown, multiline = false): string => {
    const result = text(value);
    const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
    if (result.length > 16_384 || controls.test(result)) return invalid();
    return result;
  };
  return {
    build_command: field(data.build_command, true),
    output_dir: field(data.output_dir),
    install_command: field(data.install_command, true),
    node_version: field(data.node_version),
    health_check_path: field(data.health_check_path),
  };
}

function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) return invalid();
  return result;
}
function array<T>(value: unknown, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const result: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !("value" in property) || !property.enumerable) return invalid();
    result.push(decode(property.value));
  }
  return result;
}
function token(value: unknown): DeployToken {
  const data = record(value);
  if (Object.keys(data).some(key => !["id", "name", "created_at", "last_used_at", "token", "token_encrypted"].includes(key))) return invalid();
  return {
    id: text(data.id), name: text(data.name), created_at: timestamp(data.created_at),
    ...(data.last_used_at === undefined ? {} : { last_used_at: timestamp(data.last_used_at) }),
    ...(data.token === undefined ? {} : { token: text(data.token) }),
    ...(data.token_encrypted === undefined ? {} : { token_encrypted: text(data.token_encrypted) }),
  };
}

export function parseFrontendDeploymentUpdate(value: unknown): Partial<FrontendDeploymentConfig> {
  try {
    const data = record(value);
    const allowed = [
      "name", "framework", "domain", "custom_domains", "build_command", "output_dir",
      "install_command", "node_version", "health_check_path", "env_vars",
    ];
    if (Object.keys(data).some(key => !allowed.includes(key))) return invalid();
    const framework = FRONTEND_FRAMEWORKS.find(candidate => candidate === data.framework);
    if (data.framework !== undefined && framework === undefined) return invalid();
    return {
      ...(data.name === undefined ? {} : { name: text(data.name) }),
      ...(framework === undefined ? {} : { framework }),
      ...(data.domain === undefined ? {} : { domain: text(data.domain) }),
      ...(data.custom_domains === undefined ? {} : { custom_domains: array(data.custom_domains, text) }),
      ...(data.build_command === undefined ? {} : { build_command: text(data.build_command) }),
      ...(data.output_dir === undefined ? {} : { output_dir: text(data.output_dir) }),
      ...(data.install_command === undefined ? {} : { install_command: text(data.install_command) }),
      ...(data.node_version === undefined ? {} : { node_version: text(data.node_version) }),
      ...(data.health_check_path === undefined ? {} : { health_check_path: text(data.health_check_path) }),
      ...(data.env_vars === undefined ? {} : {
        env_vars: Object.fromEntries(Object.entries(record(data.env_vars)).map(([key, value]) => [key, text(value)])),
      }),
    };
  } catch {
    throw new Error("Invalid frontend deployment update");
  }
}

export function parseFrontendDeploymentConfig(value: unknown): FrontendDeploymentConfig {
  try {
    const config = parseFrontendDeploymentUpdate(value);
    if (config.name === undefined || config.name.length === 0 || config.framework === undefined) return invalid();
    return { ...config, name: config.name, framework: config.framework };
  } catch {
    throw new Error("Invalid frontend deployment configuration");
  }
}

export function parseFrontendDeployment(
  value: unknown, projectRef: string, deploymentId: string,
): FrontendDeployment {
  try {
    const data = record(value);
    const allowed = [
      "id", "project_ref", "name", "framework", "status", "domain", "custom_domains",
      "build_command", "output_dir", "install_command", "node_version", "env_vars",
      "created_at", "updated_at", "deployment_url", "health_check_path",
      "last_deployed_at", "build_log", "git_url", "git_branch", "deploy_tokens",
    ];
    if (Object.keys(data).some(key => !allowed.includes(key))) return invalid();
    if (data.project_ref !== projectRef || data.id !== deploymentId) return invalid();
    const framework = FRONTEND_FRAMEWORKS.find(candidate => candidate === data.framework);
    const status = (["pending", "building", "success", "failed"] as const).find(candidate => candidate === data.status);
    if (!framework || !status) return invalid();
    const environment = record(data.env_vars);
    return {
      id: text(data.id), project_ref: text(data.project_ref), name: text(data.name), framework, status,
      domain: text(data.domain), custom_domains: array(data.custom_domains, text),
      build_command: text(data.build_command), output_dir: text(data.output_dir),
      install_command: text(data.install_command), node_version: text(data.node_version),
      env_vars: Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, text(value)])),
      created_at: timestamp(data.created_at), updated_at: timestamp(data.updated_at),
      deployment_url: text(data.deployment_url),
      ...(data.health_check_path === undefined ? {} : { health_check_path: text(data.health_check_path) }),
      ...(data.last_deployed_at === undefined ? {} : { last_deployed_at: timestamp(data.last_deployed_at) }),
      ...(data.build_log === undefined ? {} : { build_log: text(data.build_log) }),
      ...(data.git_url === undefined ? {} : { git_url: text(data.git_url) }),
      ...(data.git_branch === undefined ? {} : { git_branch: text(data.git_branch) }),
      ...(data.deploy_tokens === undefined ? {} : { deploy_tokens: array(data.deploy_tokens, token) }),
    };
  } catch {
    return invalid();
  }
}
