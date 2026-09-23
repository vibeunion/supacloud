import type { TaskListFilters } from "../repositories/task.repository";

export class InvalidTaskListInputError extends Error {
  constructor() {
    super("Invalid task list input");
    this.name = "InvalidTaskListInputError";
  }
}

export function taskListText(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new InvalidTaskListInputError();
  }
  try { encodeURIComponent(value); } catch { throw new InvalidTaskListInputError(); }
  return value;
}

export function captureTaskListFilters(value: unknown): TaskListFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new InvalidTaskListInputError();
  }
  const data: Record<string, unknown> = {};
  const allowed = ["statuses", "taskTypes", "functionSlug", "functionVersion", "correlationId", "businessTaskId", "onlyDeadLettered", "limit", "summary"];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw new InvalidTaskListInputError();
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property || !("value" in property)) throw new InvalidTaskListInputError();
    data[key] = property.value;
  }
  const strings = (input: unknown): string[] | undefined => {
    if (input === undefined) return undefined;
    if (!Array.isArray(input) || input.length === 0 || input.length > 10000
      || Reflect.ownKeys(input).length !== input.length + 1) throw new InvalidTaskListInputError();
    const result: string[] = [];
    for (let index = 0; index < input.length; index++) {
      const property = Object.getOwnPropertyDescriptor(input, String(index));
      if (!property || !("value" in property)) throw new InvalidTaskListInputError();
      const item = taskListText(property.value);
      if (item.includes(",")) throw new InvalidTaskListInputError();
      result.push(item);
    }
    return result;
  };
  const boolean = (input: unknown): boolean => {
    if (input === undefined) return false;
    if (typeof input !== "boolean") throw new InvalidTaskListInputError();
    return input;
  };
  const statuses = strings(data.statuses);
  const taskTypes = strings(data.taskTypes);
  const onlyDeadLettered = boolean(data.onlyDeadLettered);
  const limit = data.limit === undefined ? 50 : data.limit;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1
    || (onlyDeadLettered && statuses?.some(status => status !== "dead_lettered"))) {
    throw new InvalidTaskListInputError();
  }
  return {
    ...(statuses === undefined ? {} : { statuses }),
    ...(taskTypes === undefined ? {} : { taskTypes }),
    ...(data.functionSlug === undefined ? {} : { functionSlug: taskListText(data.functionSlug) }),
    ...(data.functionVersion === undefined ? {} : { functionVersion: taskListText(data.functionVersion) }),
    ...(data.correlationId === undefined ? {} : { correlationId: taskListText(data.correlationId) }),
    ...(data.businessTaskId === undefined ? {} : { businessTaskId: taskListText(data.businessTaskId) }),
    onlyDeadLettered, limit, summary: boolean(data.summary),
  };
}
