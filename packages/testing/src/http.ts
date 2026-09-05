/**
 * HTTP test helpers. Structural typing only — works with Elysia or any
 * fetch-style handler without importing a framework package.
 */

export interface HandleLike {
  handle(request: Request): Promise<Response> | Response;
}

/** Dispatch an in-memory request against an app handle. */
export async function testRequest(
  app: HandleLike,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, init);
  return app.handle(request);
}

/** Dispatch a request and parse the JSON body together with the status. */
export async function testJson<T = unknown>(
  app: HandleLike,
  path: string,
  init: RequestInit = {},
  decode: (value: unknown) => T,
): Promise<{ status: number; body: T }> {
  const response = await testRequest(app, path, init);
  const body = decode(await response.json());
  return { status: response.status, body };
}

export interface JsonErrorBody {
  ok: false;
  code: string;
  message: string;
  details?: unknown;
}

/** Dispatch a request and assert the standard SupaCloud JSON error contract. */
export async function testJsonError(
  app: HandleLike,
  path: string,
  expected: { status: number; code: string },
  init: RequestInit = {},
): Promise<JsonErrorBody> {
  const response = await testRequest(app, path, init);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Expected JSON error response, received status ${response.status}`);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Expected JSON error response body to be an object");
  }
  const error: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) error[key] = value;
  if (response.status !== expected.status) {
    throw new Error(`Expected status ${expected.status}, received ${response.status}`);
  }
  if (error.ok !== false || error.code !== expected.code || typeof error.message !== "string") {
    throw new Error(`Expected error code ${expected.code}, received ${String(error.code)}`);
  }
  const code = error.code;
  const message = error.message;
  if (code !== expected.code || typeof message !== "string") {
    throw new Error(`Expected error code ${expected.code}, received ${String(code)}`);
  }
  return {
    ok: false,
    code,
    message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}
