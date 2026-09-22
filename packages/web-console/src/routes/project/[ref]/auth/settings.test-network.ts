import type { ApiRequestInit } from "../../../../lib/api";

type Handler = (url: string, options: ApiRequestInit) => Promise<Response>;
let handler: Handler = async () => { throw new Error("Missing authentication fixture handler"); };

export function setApiHandler(next: Handler): void { handler = next; }
export function apiClient(url: string, options: ApiRequestInit = {}): Promise<Response> {
  return handler(url, options);
}
