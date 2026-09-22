import type { ApiRequestInit } from "../../../../lib/api";

export const page = $state({ params: { ref: "a" }, url: new URL("http://localhost/project/a/tasks") });
export const notifications: Array<{ kind: "success" | "error"; message: string }> = [];
export const toast = {
  success(message: string) { notifications.push({ kind: "success", message }); },
  error(message: string) { notifications.push({ kind: "error", message }); },
};
export const t = {
  subscribe(run: (translate: (key: string) => string) => void) {
    run(key => key);
    return () => {};
  },
};
export function resolve(path: string, params: { ref: string }): string {
  return path.replace("[ref]", encodeURIComponent(params.ref));
}
type Handler = (url: string, options: ApiRequestInit) => Promise<Response>;
let handler: Handler = async () => { throw new Error("Missing task center fixture handler"); };
export function setApiHandler(next: Handler): void { handler = next; }
export function apiClient(url: string, options: ApiRequestInit = {}): Promise<Response> { return handler(url, options); }

export class TaskSocket {
  static instances: TaskSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) { TaskSocket.instances.push(this); }
  close() { this.closed = true; }
  emit(value: unknown) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) })); }
}
