interface RuntimeIdentity {
  project_ref: string;
  authority_project_ref: string;
  local_membership_source: "project_database";
  realtime_auth_supported: boolean;
}

export type AuthRuntimeDescriptor = RuntimeIdentity & (
  | {
    mode: "local" | "owner";
    owner_project_ref: string | null;
    local_gotrue_enabled: true;
    public_auth_route: "local_gotrue";
    user_management: "local";
    configuration_management: "local";
    owner_management_path: null;
  }
  | {
    mode: "shared";
    owner_project_ref: string;
    local_gotrue_enabled: false;
    public_auth_route: "owner_proxy";
    user_management: "owner_only";
    configuration_management: "owner_only";
    owner_management_path: string;
  }
);

export class InvalidAuthRuntimeResponse extends Error {
  constructor() { super("Invalid authentication runtime response"); }
}

function isProjectRef(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function parseAuthRuntimeDescriptor(value: unknown, projectRef: string): AuthRuntimeDescriptor {
  if (!isProjectRef(projectRef) || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidAuthRuntimeResponse();
  }
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (fields.project_ref !== projectRef || !isProjectRef(fields.authority_project_ref)
    || fields.local_membership_source !== "project_database" || typeof fields.realtime_auth_supported !== "boolean") {
    throw new InvalidAuthRuntimeResponse();
  }
  const identity: RuntimeIdentity = {
    project_ref: projectRef,
    authority_project_ref: fields.authority_project_ref,
    local_membership_source: fields.local_membership_source,
    realtime_auth_supported: fields.realtime_auth_supported,
  };
  if (fields.mode === "shared") {
    if (fields.authority_project_ref === projectRef || fields.owner_project_ref !== fields.authority_project_ref
      || fields.local_gotrue_enabled !== false || fields.public_auth_route !== "owner_proxy"
      || fields.user_management !== "owner_only" || fields.configuration_management !== "owner_only"
      || fields.owner_management_path !== `/project/${fields.owner_project_ref}/auth`) {
      throw new InvalidAuthRuntimeResponse();
    }
    return {
      ...identity, mode: fields.mode, owner_project_ref: fields.owner_project_ref,
      local_gotrue_enabled: fields.local_gotrue_enabled, public_auth_route: fields.public_auth_route,
      user_management: fields.user_management, configuration_management: fields.configuration_management,
      owner_management_path: fields.owner_management_path,
    };
  }
  if ((fields.mode !== "local" && fields.mode !== "owner") || fields.authority_project_ref !== projectRef
    || (fields.owner_project_ref !== null && typeof fields.owner_project_ref !== "string")
    || fields.owner_project_ref !== (fields.mode === "local" ? null : projectRef)
    || fields.local_gotrue_enabled !== true || fields.public_auth_route !== "local_gotrue"
    || fields.user_management !== "local" || fields.configuration_management !== "local"
    || fields.owner_management_path !== null) {
    throw new InvalidAuthRuntimeResponse();
  }
  return {
    ...identity, mode: fields.mode, owner_project_ref: fields.owner_project_ref,
    local_gotrue_enabled: fields.local_gotrue_enabled, public_auth_route: fields.public_auth_route,
    user_management: fields.user_management, configuration_management: fields.configuration_management,
    owner_management_path: fields.owner_management_path,
  };
}

export async function readAuthRuntimeResponse(
  response: Response, projectRef: string, signal: AbortSignal,
): Promise<AuthRuntimeDescriptor> {
  const maxBytes = 32 * 1024;
  const reader = response.body?.getReader();
  const cancel = () => { void reader?.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const length = response.headers.get("content-length");
    if (response.status !== 200 || response.redirected || !reader
      || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes))) {
      throw new InvalidAuthRuntimeResponse();
    }
    const bytes = new Uint8Array(maxBytes);
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || size + chunk.value.byteLength > maxBytes) {
        throw new InvalidAuthRuntimeResponse();
      }
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
    } catch { throw new InvalidAuthRuntimeResponse(); }
    return parseAuthRuntimeDescriptor(value, projectRef);
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader?.releaseLock();
  }
}

export async function loadAuthRuntime(
  projectRef: string,
  request: (url: string, options: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<AuthRuntimeDescriptor> {
  if (!isProjectRef(projectRef)) throw new InvalidAuthRuntimeResponse();
  signal?.throwIfAborted();
  const controller = new AbortController();
  const aborted = Promise.withResolvers<never>();
  const abort = () => {
    controller.abort();
    aborted.reject(new DOMException("Authentication runtime request aborted", "AbortError"));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 15_000);
  try {
    // Subscribe to cancellation before starting a transport that may ignore its signal.
    const reading = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      const response = await request(`/v1/projects/${encodeURIComponent(projectRef)}/auth/runtime`, {
        signal: controller.signal, redirect: "error",
      });
      return readAuthRuntimeResponse(response, projectRef, controller.signal);
    });
    return await Promise.race([reading, aborted.promise]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
