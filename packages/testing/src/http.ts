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
): Promise<{ status: number; body: T }> {
  const response = await testRequest(app, path, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}
