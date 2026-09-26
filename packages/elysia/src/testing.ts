/** Issue an in-process request against an Elysia app. */
export function testRequest(
  app: { handle(request: Request): Response | Promise<Response> },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.handle(new Request(`http://localhost${path}`, init)));
}
