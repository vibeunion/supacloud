import type { Elysia } from "elysia";

/** Issue an in-process request against an Elysia app. */
export function testRequest(
  app: Elysia,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.handle(new Request(`http://localhost${path}`, init)));
}
