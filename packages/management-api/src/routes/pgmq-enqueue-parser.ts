import { requireProjectOrAdminAuth } from "../middleware/auth";
import { readPgmqEnqueueBody } from "../utils/pgmq-request-body";

export class PgmqEnqueueAuthError extends Error {
  constructor(readonly status: number, readonly body: { error: string }) {
    super("Queue enqueue authorization failed");
    this.name = "PgmqEnqueueAuthError";
  }
}

export async function parseAuthorizedPgmqEnqueue(
  request: Request, ref: string, batch: boolean,
): Promise<unknown> {
  try {
    const failure = await requireProjectOrAdminAuth(request, ref);
    if (failure) throw new PgmqEnqueueAuthError(failure.status, failure.body);
  } catch (error) {
    if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
    if (error instanceof PgmqEnqueueAuthError) throw error;
    throw new PgmqEnqueueAuthError(503, { error: "Queue authorization could not be confirmed" });
  }
  return readPgmqEnqueueBody(request, batch);
}
