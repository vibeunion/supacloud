import { ApplicationActiveStorage } from "./application-active-storage";
import type { ApplicationActiveRecord } from "./application-activation";

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 5_000;
const METHODS = ["GET", "HEAD"] as const;
const NON_PRODUCTION = new Set(["development", "test"]);

export interface DeveloperInvocationPolicy {
  enabled: boolean;
  methods: string[];
}

export interface DeveloperInvocationInput {
  projectRef: string;
  applicationId: string;
  environmentId: string;
  target: string;
  method: string;
  path: string;
}

export interface DeveloperInvocationDependencies {
  readActive?: (projectRef: string, applicationId: string, environmentId: string) => Promise<ApplicationActiveRecord | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Convention: loopback smoke invocation exists only outside production. */
export function developerInvocationPolicy(environment: NodeJS.ProcessEnv = process.env): DeveloperInvocationPolicy {
  const nodeEnv = (environment.NODE_ENV ?? environment.BUN_ENV ?? "production").toLowerCase();
  return { enabled: NON_PRODUCTION.has(nodeEnv), methods: [...METHODS] };
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requestPath(path: string): string {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || !path.startsWith("/") || path.includes("\\")
    || path.includes("#") || path.split("/").includes("..") || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new Error("path must be a bounded project-relative request path");
  }
  const base = new URL("http://127.0.0.1");
  const parsed = new URL(path, base);
  if (parsed.origin !== base.origin || parsed.username || parsed.password || parsed.hash) {
    throw new Error("path must stay on the application loopback origin");
  }
  return `${parsed.pathname}${parsed.search}`;
}

async function boundedText(response: Response): Promise<{ text: string | null; truncated: boolean; omitted?: string }> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded)\b)/.test(contentType)) {
    return { text: null, truncated: false, omitted: "non_text_response" };
  }
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const remaining = MAX_RESPONSE_BYTES - bytes;
      if (result.value.byteLength > remaining) {
        chunks.push(result.value.subarray(0, remaining));
        bytes += remaining;
        truncated = true;
        void reader.cancel().catch(() => {});
        break;
      }
      chunks.push(result.value);
      bytes += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))),
    truncated,
  };
}

/**
 * Invoke a route on the active application's loopback HTTP target.
 * Only non-production management hosts and GET/HEAD are reachable.
 * Caller credentials and arbitrary headers are never forwarded.
 */
export async function invokeApplicationRoute(
  input: DeveloperInvocationInput,
  policy: DeveloperInvocationPolicy = developerInvocationPolicy(),
  dependencies: DeveloperInvocationDependencies = {},
): Promise<Record<string, unknown>> {
  if (!policy.enabled) throw new Error("Developer MCP invocation is not enabled");
  const projectRef = identifier(input.projectRef, "project_ref");
  const applicationId = identifier(input.applicationId, "application_id");
  const environmentId = identifier(input.environmentId, "environment_id");
  const target = identifier(input.target, "target");
  if (environmentId.toLowerCase() === "production" || environmentId.toLowerCase() === "prod") {
    throw new Error("production environments are not invocable");
  }
  const method = input.method.toUpperCase();
  if (!policy.methods.includes(method)) throw new Error("method is not allowlisted for Developer MCP invocation");
  const path = requestPath(input.path);

  const readActive = dependencies.readActive
    ?? ((ref: string, app: string, env: string) => new ApplicationActiveStorage().readForApplication(ref, app, env));
  const active = await readActive(projectRef, applicationId, environmentId);
  if (!active) throw new Error("No active application runtime");
  const targetRecord = active.runtime.release.targets.find((candidate) => candidate.name === target && candidate.kind === "http");
  if (!targetRecord) throw new Error("target is not an active HTTP target");
  const port = active.runtime.ports[target];
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("target port is unavailable");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await (dependencies.fetch ?? fetch)(`http://127.0.0.1:${port}${path}`, {
      method,
      redirect: "error",
      signal: controller.signal,
    });
    const responseBody = await boundedText(response);
    return {
      schema: "supacloud.application-invocation.v1",
      mode: "non_production_loopback",
      project_ref: projectRef,
      application_id: applicationId,
      environment_id: environmentId,
      release_id: active.runtime.release.release_id,
      activation_id: active.runtime.activationId,
      target,
      method,
      path,
      status: response.status,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
      content_type: response.headers.get("content-type"),
      body: responseBody.text,
      ...(responseBody.truncated ? { body_truncated: true } : {}),
      ...(responseBody.omitted === undefined ? {} : { body_omitted: responseBody.omitted }),
      credentials_forwarded: false,
      redirects_followed: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}
