import type { ApiRequestInit } from "../../../../lib/api";

export const page = $state<{ params: { ref?: string } }>({ params: { ref: "a" } });
export const notifications: string[] = [];
export const toast = {
  error(message: string) { notifications.push(message); },
  success(message: string) { notifications.push(message); },
};
type Handler = (url: string, options: ApiRequestInit) => Promise<Response>;
let handler: Handler = async () => { throw new Error("Missing SQL fixture handler"); };
export function setApiHandler(next: Handler): void { handler = next; }
export function apiClient(url: string, options: ApiRequestInit = {}): Promise<Response> {
  return handler(url, options);
}
