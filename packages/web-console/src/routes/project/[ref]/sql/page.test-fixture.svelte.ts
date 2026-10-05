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
  if (/^\/v1\/projects\/[^/]+\/notebooks(?:\/|\?|$)/.test(url)) {
    return notebookHandler(url, options);
  }
  return handler(url, options);
}
let notebookHandler: Handler = async url => Response.json({
  project_ref: url.split("/")[3], items: [], next_offset: null,
});
export function setNotebookHandler(next: Handler): void { notebookHandler = next; }
