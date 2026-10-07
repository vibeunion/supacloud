<script lang="ts">
  import { page } from "$app/state";
  import { AlertCircle, Braces, Check, Clipboard, Loader2, Play, RotateCcw } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";
  import { apiClient } from "$lib/api";
  import { getProjectApiUrl } from "$lib/project-api-url";

  type Project = {
    anon_key?: string;
    api?: { url?: string };
    endpoint?: string;
  };

  const projectRef = $derived(page.params.ref);
  const projectQuery = createQuery(() => ({
    queryKey: ["v1/projects", "getOne", projectRef],
    enabled: Boolean(projectRef),
    queryFn: async (): Promise<Project> => {
      const response = await apiClient(`/v1/projects/${projectRef}`);
      if (!response.ok) throw new Error("Unable to load project");
      const payload = await response.json() as unknown;
      if (payload && typeof payload === "object" && !Array.isArray(payload)
        && "data" in payload && payload.data && typeof payload.data === "object") {
        return payload.data as Project;
      }
      return payload as Project;
    },
  }));

  let query = $state(`query IntrospectionPreview {
  __typename
}`);
  let variables = $state("{}");
  let operationName = $state("");
  let responseText = $state("");
  let error = $state("");
  let running = $state(false);
  let copied = $state(false);

  const project = $derived(projectQuery.data);
  const apiUrl = $derived(getProjectApiUrl(project));

  async function execute() {
    error = "";
    responseText = "";
    running = true;
    try {
      let parsedVariables: unknown = {};
      try {
        parsedVariables = JSON.parse(variables || "{}");
      } catch {
        throw new Error("Variables must be valid JSON");
      }
      if (!parsedVariables || typeof parsedVariables !== "object" || Array.isArray(parsedVariables)) {
        throw new Error("Variables must be a JSON object");
      }
      if (!apiUrl || !project?.anon_key) throw new Error("The project API URL or anon key is unavailable");
      const response = await fetch(`${apiUrl}/graphql/v1`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: project.anon_key,
          Authorization: `Bearer ${project.anon_key}`,
        },
        body: JSON.stringify({
          query,
          variables: parsedVariables,
          ...(operationName.trim() ? { operationName: operationName.trim() } : {}),
        }),
      });
      const body = await response.text();
      try {
        responseText = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        responseText = body;
      }
      if (!response.ok) throw new Error(`GraphQL request failed (${response.status})`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "GraphQL request failed";
    } finally {
      running = false;
    }
  }

  async function copyResponse() {
    if (!responseText) return;
    try {
      await navigator.clipboard.writeText(responseText);
      copied = true;
      setTimeout(() => copied = false, 1600);
    } catch {
      error = "Unable to copy response";
    }
  }

  function reset() {
    query = `query IntrospectionPreview {
  __typename
}`;
    variables = "{}";
    operationName = "";
    responseText = "";
    error = "";
  }
</script>

<svelte:head>
  <title>GraphQL Explorer | SupaCloud</title>
</svelte:head>

<div class="mx-auto max-w-7xl space-y-5">
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div>
      <div class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-brand">
        <Braces class="h-4 w-4" />
        Database GraphQL
      </div>
      <h1 class="text-2xl font-bold tracking-tight">GraphQL Explorer</h1>
      <p class="mt-1 max-w-2xl text-sm text-muted-foreground">Run role-scoped queries against the project's Supabase-compatible pg_graphql endpoint.</p>
    </div>
    <div class="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <div class="font-medium text-foreground">/graphql/v1</div>
      <div>{apiUrl || "Project API URL unavailable"}</div>
    </div>
  </div>

  <div class="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <section class="overflow-hidden rounded-lg border bg-card">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <div class="text-sm font-semibold">Request</div>
        <div class="flex items-center gap-2">
          <button class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted" onclick={reset} title="Reset">
            <RotateCcw class="h-3.5 w-3.5" />
            Reset
          </button>
          <button class="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 disabled:opacity-50" onclick={execute} disabled={running || !projectRef}>
            {#if running}<Loader2 class="h-3.5 w-3.5 animate-spin" />{:else}<Play class="h-3.5 w-3.5" />{/if}
            Run
          </button>
        </div>
      </div>
      <div class="space-y-4 p-4">
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-muted-foreground">Operation name</span>
          <input bind:value={operationName} class="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:border-brand" placeholder="Optional" />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-muted-foreground">Query</span>
          <textarea bind:value={query} class="min-h-72 w-full resize-y rounded-md border bg-zinc-950 p-3 font-mono text-sm leading-6 text-zinc-100 outline-none focus:border-brand" spellcheck="false"></textarea>
        </label>
        <label class="block">
          <span class="mb-1.5 block text-xs font-medium text-muted-foreground">Variables</span>
          <textarea bind:value={variables} class="min-h-28 w-full resize-y rounded-md border bg-zinc-950 p-3 font-mono text-sm leading-6 text-zinc-100 outline-none focus:border-brand" spellcheck="false"></textarea>
        </label>
      </div>
    </section>

    <section class="overflow-hidden rounded-lg border bg-card">
      <div class="flex items-center justify-between border-b px-4 py-3">
        <div class="text-sm font-semibold">Response</div>
        <button class="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50" onclick={copyResponse} disabled={!responseText} title="Copy">
          {#if copied}<Check class="h-3.5 w-3.5 text-emerald-600" />{:else}<Clipboard class="h-3.5 w-3.5" />{/if}
          Copy
        </button>
      </div>
      <div class="min-h-[38rem] bg-zinc-950 p-4">
        {#if error}
          <div class="mb-3 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
            <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        {/if}
        {#if responseText}
          <pre class="overflow-auto whitespace-pre-wrap font-mono text-sm leading-6 text-zinc-100">{responseText}</pre>
        {:else if !error}
          <div class="flex h-full min-h-[32rem] items-center justify-center text-center text-sm text-zinc-500">
            Run a query to inspect the GraphQL response.
          </div>
        {/if}
      </div>
    </section>
  </div>
</div>
