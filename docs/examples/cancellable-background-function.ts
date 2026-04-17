import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Task cancelled", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

serve(async (req) => {
  const payload = await req.json();
  req.signal.throwIfAborted?.();

  const taskId = Deno.env.get("SUPACLOUD_BACKGROUND_TASK_ID") || "unknown";
  const attempt = Deno.env.get("SUPACLOUD_BACKGROUND_ATTEMPT") || "1";

  const abortController = new AbortController();
  const onAbort = () => abortController.abort("supacloud task cancelled");
  req.signal.addEventListener("abort", onAbort, { once: true });

  try {
    for (let step = 0; step < 5; step += 1) {
      req.signal.throwIfAborted?.();

      console.log(
        `[background-task] task=${taskId} attempt=${attempt} step=${step}`,
      );

      await sleep(1000, abortController.signal);
    }

    return Response.json({
      ok: true,
      task_id: taskId,
      attempt,
      payload,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.warn(`[background-task] task=${taskId} cancelled`);
      return Response.json(
        {
          ok: false,
          cancelled: true,
          task_id: taskId,
        },
        { status: 499 },
      );
    }

    throw error;
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
});
