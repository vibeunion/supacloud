import type { SupabaseClient } from "@supabase/supabase-js";

type WorkflowMutationName =
  | "supacloud_workflow_start" | "supacloud_workflow_claim" | "supacloud_workflow_cancel"
  | "supacloud_workflow_complete" | "supacloud_workflow_fail" | "supacloud_workflow_advance"
  | "supacloud_workflow_retry";
type WorkflowReadName = "supacloud_workflow_get" | "supacloud_workflow_events";

export function invokeWorkflowMutation(
  supabase: SupabaseClient,
  functionName: WorkflowMutationName,
  request: object,
  unconfirmed: () => Error,
): Promise<unknown> {
  return invokeWorkflowRpc(supabase, functionName, request, unconfirmed);
}

export function invokeWorkflowRead(
  supabase: SupabaseClient,
  functionName: WorkflowReadName,
  request: object,
  invalid: () => Error,
): Promise<unknown> {
  return invokeWorkflowRpc(supabase, functionName, request, invalid);
}

async function invokeWorkflowRpc(
  supabase: SupabaseClient,
  functionName: WorkflowMutationName | WorkflowReadName,
  request: object,
  failure: () => Error,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(failure());
      controller.abort();
    }, 15000);
  });
  let result: { data: unknown; error: unknown; status: number };
  try {
    const pending = supabase.rpc(functionName, { request })
      .retry(false).abortSignal(controller.signal);
    result = await Promise.race([pending, deadline]);
  } catch {
    throw failure();
  } finally {
    clearTimeout(timer);
  }
  if (result.error && result.status >= 400 && result.status < 500) throw result.error;
  if (result.error || result.status !== 200) throw failure();
  return result.data;
}
