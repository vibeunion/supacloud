import { SupaCloudApiError } from "./api-error.js";
import { queueJsonSnapshot } from "./queue-rpc.js";
import { captureWorkflowRunId, decodeWorkflowRun } from "./workflow-run.js";
import { workflowJsonEqual } from "./workflow-json.js";
import type { SupaCloudWorkflowRun, SupaCloudWorkflowStartRequest } from "./workflows.js";

export class SupaCloudWorkflowStartError extends SupaCloudApiError {
  constructor(readonly mutationMayHaveApplied = false) {
    super("Workflow start could not be validated", 0, {
      code: mutationMayHaveApplied ? "WORKFLOW_START_UNCONFIRMED" : "WORKFLOW_START_INPUT_INVALID",
      mutation_may_have_applied: mutationMayHaveApplied,
    });
    this.name = "SupaCloudWorkflowStartError";
  }
}
function fail(): never { throw new SupaCloudWorkflowStartError(); }
function normalized(value: unknown, max: number): string {
  if (typeof value !== "string") return fail();
  const result = value.replace(/^ +| +$/g, "");
  let count = 0;
  for (const character of result) {
    const code = character.codePointAt(0);
    if (++count > max || code === 0 || (code !== undefined && code >= 0xd800 && code <= 0xdfff)) return fail();
  }
  return count > 0 ? result : fail();
}
function key(value: unknown): string {
  const result = normalized(value, 120);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(result) ? result : fail();
}
export function captureWorkflowStart(value: unknown): Required<SupaCloudWorkflowStartRequest> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || Object.getOwnPropertySymbols(value).length !== 0) return fail();
    const fields = Object.getOwnPropertyDescriptors(value);
    for (const name of Object.keys(fields)) {
      const field = fields[name];
      if (!["runId", "workflowName", "workflowVersion", "firstStepKey", "input", "maxAttempts"].includes(name)
        || !field || !field.enumerable || !("value" in field)) return fail();
    }
    const get = (name: string): unknown => fields[name]?.value;
    const input = queueJsonSnapshot(get("input") === undefined ? {} : get("input"));
    if (input === null || typeof input !== "object" || Array.isArray(input)) return fail();
    const maxAttempts = get("maxAttempts") === undefined ? 3 : get("maxAttempts");
    if (typeof maxAttempts !== "number" || !Number.isSafeInteger(maxAttempts)
      || maxAttempts < 1 || maxAttempts > 100) return fail();
    return {
      runId: captureWorkflowRunId(get("runId")), workflowName: key(get("workflowName")),
      workflowVersion: normalized(get("workflowVersion"), 80), firstStepKey: key(get("firstStepKey")),
      input, maxAttempts,
    };
  } catch { return fail(); }
}

export function decodeWorkflowStart(value: unknown, request: Required<SupaCloudWorkflowStartRequest>): SupaCloudWorkflowRun {
  try {
    const run = decodeWorkflowRun(value, request.runId, true);
    const successors = new Set(run?.steps.map(step => step.nextStepKey));
    const first = run?.steps.find(step => !successors.has(step.stepKey));
    if (!run || !first || run.workflowName !== request.workflowName || run.workflowVersion !== request.workflowVersion
      || first.stepKey !== request.firstStepKey || first.maxAttempts !== request.maxAttempts
      || !workflowJsonEqual(run.input, request.input) || !workflowJsonEqual(first.input, request.input)) throw new Error();
    if (!run.idempotent && (run.status !== "queued" || run.steps.length !== 1 || first.status !== "queued"
      || first.attempts !== 0 || run.rowVersion !== "1")) throw new Error();
    return run;
  } catch {
    throw new SupaCloudWorkflowStartError(true);
  }
}
