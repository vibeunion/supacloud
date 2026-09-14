import { queueJsonSnapshot } from "./queue-rpc.js";

export function workflowJsonObject(value: unknown): Record<string, unknown> {
  const captured = queueJsonSnapshot(value === undefined ? {} : value);
  if (captured === null || typeof captured !== "object" || Array.isArray(captured)) throw new Error();
  return captured;
}

// Callers supply bounded, detached JSON trees, never arbitrary live objects.
export function workflowJsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((item, index) => workflowJsonEqual(item, right[index]));
  }
  if (Array.isArray(right)) return false;
  const a: Array<[string, unknown]> = Object.entries(left);
  const b: Array<[string, unknown]> = Object.entries(right);
  const values = new Map(b);
  return a.length === b.length && a.every(([name, value]) => values.has(name) && workflowJsonEqual(value, values.get(name)));
}
