/** Issue an in-process request against an Elysia app. */
export function testRequest(
  app: { handle(request: Request): Response | Promise<Response> },
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return Promise.resolve(app.handle(new Request(`http://localhost${path}`, init)));
}

type TestInvokerRequest = {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, unknown>;
  cookie?: Record<string, unknown>;
  context?: unknown;
};

/** Build generated-route-shaped invokers for hand-authored test modules. */
export function testInvoker(handlerName: string) {
  return (controller: unknown, request: TestInvokerRequest) => {
    if (controller === null || typeof controller !== "object") {
      throw new TypeError("Test route controller is not an object");
    }
    const handler = (controller as Record<string, unknown>)[handlerName];
    if (typeof handler !== "function") {
      throw new TypeError(`Test route handler ${handlerName} is not callable`);
    }
    return Reflect.apply(handler, controller, [request]);
  };
}
