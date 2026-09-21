import type { ProjectStatus } from "../db";

type DesiredState = "running" | "stopped";
const legacyDesired = new Map<string, DesiredState>(Object.entries({
  active: "running",
  creating: "stopped",
  paused: "stopped",
  deleted: "stopped",
} satisfies Record<ProjectStatus, DesiredState>));

export class InvalidPostgrestDesiredStateError extends Error {
  constructor() {
    super("Invalid persisted PostgREST desired state");
    this.name = "InvalidPostgrestDesiredStateError";
  }
}

function ownValue(project: object, key: string): unknown {
  const property = Object.getOwnPropertyDescriptor(project, key);
  if (!property) return undefined;
  if (!("value" in property)) throw new InvalidPostgrestDesiredStateError();
  return property.value;
}

export function parsePostgrestDesiredState(project: unknown): DesiredState {
  try {
    if (!project || typeof project !== "object" || Array.isArray(project)) {
      throw new InvalidPostgrestDesiredStateError();
    }
    const prototype: unknown = Object.getPrototypeOf(project);
    if (prototype !== null && prototype !== Object.prototype) throw new InvalidPostgrestDesiredStateError();
    const desired = ownValue(project, "postgrest_desired");
    if (desired === "running" || desired === "stopped") return desired;
    if (desired !== undefined && desired !== null) throw new InvalidPostgrestDesiredStateError();
    const status = ownValue(project, "status");
    const fallback = typeof status === "string" ? legacyDesired.get(status) : undefined;
    if (fallback === undefined) throw new InvalidPostgrestDesiredStateError();
    return fallback;
  } catch {
    throw new InvalidPostgrestDesiredStateError();
  }
}
