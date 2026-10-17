import { Elysia, status, t } from "elysia";
import { app } from "../../src/index";
import { checkAuth } from "../../src/middleware/auth";
import { AppError } from "../../src/utils/errors";

// These probes share the real app hooks but never call a business write handler.
const probes = new Elysia()
  .get("/__aot_parity/validation", {
    query: t.Object({ limit: t.Integer({ minimum: 1 }) }),
  }, ({ query }) => ({ value: query.limit, type: typeof query.limit }))
  .post("/__aot_parity/body", {
    body: t.Object({ name: t.String({ minLength: 1 }) }),
  }, ({ body }) => body)
  .post("/storage/v1/__aot_parity/body", {
    body: t.Object({ name: t.String({ minLength: 1 }) }),
  }, ({ body }) => body)
  .get("/__aot_parity/auth", {
    beforeHandle: async ({ request }) => {
      const failure = await checkAuth(request);
      if (failure) {
        return status(failure.status, { message: failure.body.error, code: String(failure.status) });
      }
    },
  }, () => ({ authorized: true }))
  .get("/__aot_parity/error/:code", ({ params }) => {
    const codes: Record<string, number> = {
      bad_request: 400, forbidden: 403, conflict: 409, validation: 422, internal: 500, unavailable: 503,
    };
    throw new AppError("Controlled error", codes[params.code] ?? 500, "PARITY_ERROR", "safe detail", "safe hint");
  })
  .post("/__aot_parity/upload", {
    body: t.Object({ file: t.File() }),
  }, async ({ body }) => ({ name: body.file.name, content: await body.file.text() }))
  .get("/__aot_parity/stream", () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first\n"));
      controller.enqueue(new TextEncoder().encode("second\n"));
      controller.close();
    },
  }), { headers: { "content-type": "text/plain" } }))
  .ws("/__aot_parity/ws", {
    message(ws, message) { ws.send(message); },
  });

app.use(probes);

export { app };
