import type { QueryClient } from "@tanstack/svelte-query";

let client: QueryClient | undefined;
export function registerFixtureClient(value: QueryClient) { client = value; }
export function readFixtureMutationState(): unknown[] {
  if (!client) throw new Error("Missing fixture query client");
  return client.getMutationCache().getAll().map(mutation => mutation.state);
}

export const page = $state({
  params: { ref: "a" },
  url: new URL("http://localhost/project/a/hosting/dep-a"),
});
