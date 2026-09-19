import { TaskOutputError, taskOutputQuery, taskOutputScope, readTaskOutputBody, type AppendTaskOutput } from "../utils/task-output";

export type TaskOutputReadAuthorization = { invokerUserId: string | null } | Response;
export interface TaskOutputDependencies {
  authorizeRead(request: Request, projectRef: string): Promise<TaskOutputReadAuthorization>;
  authorizeWrite(request: Request, projectRef: string): Promise<Response | null>;
  read(projectRef: string, taskId: string, after: string, limit: number, invokerUserId: string | null): Promise<Record<string, unknown>>;
  append(projectRef: string, taskId: string, input: AppendTaskOutput): Promise<Record<string, unknown>>;
}

export function taskOutputResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

/** Error bodies are intentionally not derived from database exception messages. */
export function taskOutputFailure(error: unknown): Response {
  if (error instanceof TaskOutputError) return taskOutputResponse({ code: error.code, message: error.message }, error.statusCode);
  return taskOutputResponse({ code: "TASK_OUTPUT_UNAVAILABLE", message: "Task output is temporarily unavailable" }, 503);
}

export function createTaskOutputHandlers(dependencies: TaskOutputDependencies) {
  return {
    async read(request: Request, params: { ref: string; taskId: string }): Promise<Response> {
      try {
        const { projectRef, taskId } = taskOutputScope(params.ref, params.taskId);
        const auth = await dependencies.authorizeRead(request, projectRef);
        if (auth instanceof Response) return auth;
        const { after, limit } = taskOutputQuery(new URL(request.url));
        const page = await dependencies.read(projectRef, taskId, after, limit, auth.invokerUserId);
        if (page.replay_available === false) return taskOutputResponse({ ...page, code: "TASK_OUTPUT_REPLAY_UNAVAILABLE" }, 410);
        return taskOutputResponse(page);
      } catch (error) { return taskOutputFailure(error); }
    },
    async append(request: Request, params: { ref: string; taskId: string }): Promise<Response> {
      try {
        const { projectRef, taskId } = taskOutputScope(params.ref, params.taskId);
        const rejected = await dependencies.authorizeWrite(request, projectRef);
        if (rejected) return rejected;
        const event = await readTaskOutputBody(request);
        return taskOutputResponse(await dependencies.append(projectRef, taskId, event));
      } catch (error) { return taskOutputFailure(error); }
    },
  };
}
