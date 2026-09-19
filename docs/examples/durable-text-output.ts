/** Server-only adapter for an EXISTING background function, not a new worker. */
import { createTaskEventClient } from "@supacloud/js/task-events";

type TextTaskOptions = {
  events: ReturnType<typeof createTaskEventClient>;
  taskId: string;
  attempt: number;
  generate: (input: unknown, signal: AbortSignal) => AsyncIterable<string>;
};

/** Inject a model provider's text iterator; do not expose executor credentials to a browser. */
export async function runDurableTextOutput(request: Request, options: TextTaskOptions): Promise<Response> {
  const input: unknown = await request.json();
  const encoder = new TextEncoder();
  const pieces: string[] = [];
  let bytes = 0;
  for await (const text of options.generate(input, request.signal)) {
    request.signal.throwIfAborted();
    // Example limits; larger artifacts belong in Storage, not this event journal.
    const size = encoder.encode(text).byteLength;
    bytes += size;
    if (size > 8 * 1024 || bytes > 64 * 1024) throw new Error("Text output exceeds example limits");
    if (!text) continue;
    // Commit before publishing/returning output. On an uncertain write, explicitly
    // retry this SAME event_id; never regenerate it inside a transport retry loop.
    await options.events.append(options.taskId, {
      event_id: crypto.randomUUID(), attempt: options.attempt,
      type: "output.delta", payload: { text },
    }, { signal: request.signal });
    pieces.push(text);
  }
  request.signal.throwIfAborted();
  // The existing executor persists this result and makes its lifecycle transition.
  return Response.json({ text: pieces.join(""), attempt: options.attempt });
}
