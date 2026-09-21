import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

type ProjectFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ProjectCliTransport {
  apiUrl: string;
  getToken: () => string | Promise<string>;
  fetch?: ProjectFetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class InvalidProjectCliReceiptError extends Error {
  constructor() {
    super("Project API returned an invalid receipt. Inspect project state before retrying a mutation.");
    this.name = "InvalidProjectCliReceiptError";
  }
}

export class ProjectCliHttpError extends Error {
  constructor(readonly statusCode: number) {
    super(`Project API returned HTTP ${statusCode}. Inspect project state before retrying a mutation.`);
    this.name = "ProjectCliHttpError";
  }
}

function cancelBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

export async function requestProjectJson(
  transport: ProjectCliTransport,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  let serialized: string | undefined;
  try { serialized = body === undefined ? undefined : JSON.stringify(body); }
  catch { throw new Error("Request body is not a JSON value"); }
  if (body !== undefined && serialized === undefined) throw new Error("Request body is not a JSON value");
  let base: URL;
  try { base = new URL(transport.apiUrl); } catch { throw new Error("Invalid project API URL"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !/^\/v1\/projects(?:\/|$)/.test(path) || /[?#\\\r\n\0]/.test(path)) throw new Error("Invalid project API URL");
  const pathname = `${base.pathname.replace(/\/$/, "")}${path}`;
  const url = new URL(`${base.origin}${pathname}`);
  if (url.origin !== base.origin || url.pathname !== pathname) throw new Error("Invalid project API URL");
  const timeoutMs = transport.timeoutMs ?? 30_000;
  const maxBytes = transport.maxResponseBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) {
    throw new Error("Invalid project API transport limits");
  }
  const token = await transport.getToken();
  if (typeof token !== "string" || !token || /[\r\n\0]/.test(token)) throw new Error("Invalid project API token");
  const controller = new AbortController();
  let rejectDeadline: (reason: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error("Project API request timed out"));
  }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  try {
    const pending = (transport.fetch ?? fetch)(url, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(serialized === undefined ? {} : { body: serialized }),
      redirect: "error",
      signal: controller.signal,
    });
    // An injected transport may settle after the deadline without honoring cancellation.
    void pending.then(response => { if (controller.signal.aborted) cancelBody(response); }, () => {});
    const response = await Promise.race([pending, deadline]);
    if (!response.ok) {
      cancelBody(response);
      throw new ProjectCliHttpError(response.status);
    }
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (contentType !== "application/json" && !contentType?.match(/^application\/[a-z0-9.+-]+\+json$/)) {
      cancelBody(response);
      throw new InvalidProjectCliReceiptError();
    }
    reader = response.body?.getReader();
    if (!reader) throw new InvalidProjectCliReceiptError();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]+(?![\s\S])/.test(length) || Number(length) > maxBytes)) {
      throw new InvalidProjectCliReceiptError();
    }
    let bytes = new Uint8Array(Math.min(64 * 1024, maxBytes));
    let size = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || size + chunk.value.byteLength > maxBytes) {
        throw new InvalidProjectCliReceiptError();
      }
      size += chunk.value.byteLength;
      if (size > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(maxBytes, Math.max(size, bytes.byteLength * 2)));
        expanded.set(bytes);
        bytes = expanded;
      }
      bytes.set(chunk.value, size - chunk.value.byteLength);
    }
    const result: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    completed = true;
    return result;
  } catch (error) {
    if (error instanceof ProjectCliHttpError) throw error;
    // Neither malformed success bytes nor a lost response prove that a mutation did not commit.
    throw new InvalidProjectCliReceiptError();
  } finally {
    clearTimeout(timer);
    if (!completed) controller.abort();
    void reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

const printablePattern = "^[^\\u0000-\\u001f\\u007f-\\u009f]*(?![\\s\\S])";
const text = Type.String({ minLength: 1, pattern: printablePattern });
const projectSchema = Type.Object({
  ref: text, name: text, status: text,
  region: Type.Optional(text), created_at: Type.Optional(text),
  api: Type.Optional(Type.Object({ url: Type.String() })),
  studio: Type.Optional(Type.Object({ url: Type.String() })),
  api_url: Type.Optional(Type.String()), apiUrl: Type.Optional(Type.String()),
  studio_url: Type.Optional(Type.String()), studioUrl: Type.Optional(Type.String()),
  database: Type.Optional(Type.Object({ host: Type.Optional(text), name: Type.Optional(text) })),
  anon_key: Type.Optional(text),
});

function projectUrl(project: Static<typeof projectSchema>, key: "api" | "studio"): string {
  const candidates = key === "api"
    ? [project.api?.url, project.api_url, project.apiUrl]
    : [project.studio?.url, project.studio_url, project.studioUrl];
  const values = candidates.filter((value): value is string => value !== undefined && value !== "");
  if (new Set(values).size > 1) throw new InvalidProjectCliReceiptError();
  const value = values[0];
  if (value === undefined) return "";
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || /[\u0000-\u0020\u007f-\u009f]/.test(value)) {
      throw new InvalidProjectCliReceiptError();
    }
  } catch { throw new InvalidProjectCliReceiptError(); }
  return value;
}

export function readCliProject(value: unknown, expectedRef?: string) {
  if (!Value.Check(projectSchema, value) || (expectedRef !== undefined && value.ref !== expectedRef)) {
    throw new InvalidProjectCliReceiptError();
  }
  if (value.created_at !== undefined && !Number.isFinite(Date.parse(value.created_at))) {
    throw new InvalidProjectCliReceiptError();
  }
  if (value.database !== undefined && value.database.host === undefined && value.database.name === undefined) {
    throw new InvalidProjectCliReceiptError();
  }
  return {
    ref: value.ref, name: value.name, status: value.status,
    apiUrl: projectUrl(value, "api"), studioUrl: projectUrl(value, "studio"),
    ...(value.region === undefined ? {} : { region: value.region }),
    ...(value.created_at === undefined ? {} : { createdAt: value.created_at }),
    ...(value.database?.host === undefined ? {} : { databaseHost: value.database.host }),
    ...(value.database?.name === undefined ? {} : { databaseName: value.database.name }),
    ...(value.anon_key === undefined ? {} : { anonKey: value.anon_key }),
  };
}

const createSchema = Type.Object({
  credentials: Type.Object({ service_role_key: Type.String({ minLength: 32, pattern: printablePattern }) }),
});
export function readCliProjectCreate(value: unknown, expected: { name: string; region?: string }) {
  const project = readCliProject(value);
  if (!Value.Check(createSchema, value) || project.name !== expected.name
    || (expected.region !== undefined && project.region !== expected.region)
    || /^\*+$/.test(value.credentials.service_role_key)) throw new InvalidProjectCliReceiptError();
  return { ...project, serviceRoleKey: value.credentials.service_role_key };
}

function projectPath(ref: string): string {
  if (typeof ref !== "string" || !ref || ref === "." || ref === ".." || /[\r\n\0]/.test(ref)) {
    throw new Error("Invalid project ref");
  }
  return `/v1/projects/${encodeURIComponent(ref)}`;
}

const createInputSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100, pattern: printablePattern }),
  domain: Type.Optional(text),
  region: Type.Optional(text),
});
export type ProjectCliCreateInput = Static<typeof createInputSchema>;
const keySchema = Type.Object({
  name: Type.Union([Type.Literal("publishable"), Type.Literal("secret"), Type.Literal("anon"), Type.Literal("service_role")]),
  api_key: Type.String({ pattern: printablePattern }),
});
const jwtKeysSchema = Type.Object({ anon_key: text, service_role_key: Type.String({ pattern: printablePattern }) });
const opaqueKeysSchema = Type.Object({ publishable_key: text, secret_key: text });

export class ProjectCliClient {
  constructor(private readonly transport: ProjectCliTransport) {}

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, decode: (value: unknown) => T, body?: unknown) {
    return decode(await requestProjectJson(this.transport, method, path, body));
  }

  async list() {
    return this.request("GET", "/v1/projects", value => {
      if (!Array.isArray(value)) throw new InvalidProjectCliReceiptError();
      const refs = new Set<string>();
      return Array.from(value, (candidate: unknown) => {
        const project = readCliProject(candidate);
        if (refs.has(project.ref)) throw new InvalidProjectCliReceiptError();
        refs.add(project.ref);
        return project;
      });
    });
  }

  async create(input: ProjectCliCreateInput) {
    if (!Value.Check(createInputSchema, input)) throw new Error("Invalid project create input");
    const snapshot = {
      name: input.name,
      ...(input.domain === undefined ? {} : { domain: input.domain }),
      ...(input.region === undefined ? {} : { region: input.region }),
    };
    return this.request("POST", "/v1/projects", value => readCliProjectCreate(value, snapshot), {
      ...snapshot, credential_delivery: "response",
    });
  }

  async get(ref: string) {
    return this.request("GET", projectPath(ref), value => {
      const project = readCliProject(value, ref);
      if (project.region === undefined || project.createdAt === undefined
        || (project.databaseHost === undefined && project.databaseName === undefined)) {
        throw new InvalidProjectCliReceiptError();
      }
      return { ...project, region: project.region, createdAt: project.createdAt };
    });
  }

  async delete(ref: string) {
    return this.request("DELETE", projectPath(ref), value => readCliProject(value, ref));
  }

  async transition(ref: string, action: "pause" | "restore") {
    if (action !== "pause" && action !== "restore") throw new Error("Invalid project action");
    return this.request("POST", `${projectPath(ref)}/${action}`, value => {
      const project = readCliProject(value, ref);
      const allowed = action === "pause" ? ["paused", "INACTIVE"] : ["active", "ACTIVE_HEALTHY"];
      if (!allowed.includes(project.status)) throw new InvalidProjectCliReceiptError();
      return project;
    });
  }

  async restart(ref: string) {
    return this.request("POST", `${projectPath(ref)}/restart`, value => {
      const schema = Type.Object({ ref: text, message: text });
      if (!Value.Check(schema, value) || value.ref !== ref) throw new InvalidProjectCliReceiptError();
      return { ref: value.ref, message: value.message };
    });
  }

  async keys(ref: string) {
    return this.request("GET", `${projectPath(ref)}/api-keys`, value => {
      if (!Array.isArray(value) || value.length !== 4) throw new InvalidProjectCliReceiptError();
      const keys = new Map<string, string>();
      for (const key of value) {
        if (!Value.Check(keySchema, key) || keys.has(key.name)) throw new InvalidProjectCliReceiptError();
        keys.set(key.name, key.api_key);
      }
      const publishable = keys.get("publishable"), secret = keys.get("secret");
      const anon = keys.get("anon"), service_role = keys.get("service_role");
      if (publishable === undefined || secret === undefined || anon === undefined || service_role === undefined) {
        throw new InvalidProjectCliReceiptError();
      }
      return { publishable, secret, anon, service_role };
    });
  }

  async rotateKeys(ref: string) {
    return this.request("POST", `${projectPath(ref)}/api-keys/rotate`, value => {
      if (!Value.Check(jwtKeysSchema, value)) throw new InvalidProjectCliReceiptError();
      return { anon_key: value.anon_key, service_role_key: value.service_role_key };
    });
  }

  async rotateOpaqueKeys(ref: string) {
    return this.request("POST", `${projectPath(ref)}/api-keys/rotate-opaque`, value => {
      if (!Value.Check(opaqueKeysSchema, value) || /^\*+$/.test(value.secret_key)) throw new InvalidProjectCliReceiptError();
      return { publishable_key: value.publishable_key, secret_key: value.secret_key };
    });
  }
}
