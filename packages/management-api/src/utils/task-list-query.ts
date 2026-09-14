import type { TaskListFilters } from "../repositories/task.repository";
import { captureTaskListFilters, InvalidTaskListInputError } from "./task-list-input";

export class InvalidTaskListQueryError extends Error {
    constructor() {
        super("Invalid task list query");
        this.name = "InvalidTaskListQueryError";
    }
}

export function parseTaskListQuery(request: Request, deadLettered = false): TaskListFilters {
    const query = new URL(request.url).searchParams;
    const allowed = new Set(deadLettered
        ? ["limit", "summary"]
        : ["status", "task_type", "function_slug", "function_version", "dlq", "limit", "summary"]);
    const seen = new Set<string>();
    for (const [key] of query) {
        if (!allowed.has(key) || seen.has(key)) throw new InvalidTaskListQueryError();
        seen.add(key);
    }
    const text = (value: string): string => {
        if (!value || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
            throw new InvalidTaskListQueryError();
        }
        return value;
    };
    const list = (key: string): string[] | undefined => {
        const value = query.get(key);
        return value === null ? undefined : value.split(",").map(text);
    };
    const optionalText = (key: string): string | undefined => {
        const value = query.get(key);
        return value === null ? undefined : text(value);
    };
    const boolean = (key: string): boolean => {
        const value = query.get(key);
        if (value === null || value === "false") return false;
        if (value !== "true") throw new InvalidTaskListQueryError();
        return true;
    };
    const rawLimit = query.get("limit");
    const limit = rawLimit === null ? (deadLettered ? 100 : 50) : Number(rawLimit);
    if ((rawLimit !== null && !/^[1-9][0-9]*$/.test(rawLimit)) || !Number.isSafeInteger(limit)) {
        throw new InvalidTaskListQueryError();
    }
    const statuses = list("status");
    const taskTypes = list("task_type");
    const functionSlug = optionalText("function_slug");
    const functionVersion = optionalText("function_version");
    const onlyDeadLettered = deadLettered || boolean("dlq");
    if (onlyDeadLettered && statuses?.some(value => value !== "dead_lettered")) {
        throw new InvalidTaskListQueryError();
    }
    try {
        return captureTaskListFilters({
            ...(statuses === undefined ? {} : { statuses }),
            ...(taskTypes === undefined ? {} : { taskTypes }),
            ...(functionSlug === undefined ? {} : { functionSlug }),
            ...(functionVersion === undefined ? {} : { functionVersion }),
            onlyDeadLettered, limit, summary: boolean("summary"),
        });
    } catch (error) {
        if (error instanceof InvalidTaskListInputError) throw new InvalidTaskListQueryError();
        throw error;
    }
}
