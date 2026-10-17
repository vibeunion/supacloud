<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { t } from "svelte-i18n";
  import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-svelte";
  import Button from "@svadmin/ui/components/ui/button/button.svelte";
  import { apiClient } from "$lib/api";
  import {
    ApplicationRuntimeChanged, validApplicationScope, loadApplicationRuntime, loadApplicationReleases,
    loadApplicationDeploymentEvidence, type RuntimeResponse, type ReleasePage, type DeploymentEvidenceResponse,
  } from "$lib/application-dashboard";
  import {
    loadApplicationDevelopment, type ApplicationDevelopmentResponse,
  } from "$lib/application-development";

  type PreviewRecord = {
    preview_id: string; status: string; release_id: string; branch_name: string;
    created_at: string; updated_at: string;
    cleanup: { required: boolean; completed: boolean; error: string | null };
    resources: {
      database_branch: { status: string; branch_ref: string };
      smoke_test: { status: string; passed: string[]; failed: string[] };
    };
  };

  let application = $state("");
  let environment = $state("");
  let runtime = $state<RuntimeResponse | null>(null);
  let releases = $state<ReleasePage | null>(null);
  let runtimeState = $state("idle");
  let evidence = $state<DeploymentEvidenceResponse | null>(null);
  let evidenceState = $state("idle");
  let releaseState = $state("idle");
  let revision = $state(0);
  let cursor = $state<string | undefined>();
  let previousCursors = $state<(string | undefined)[]>([]);
  let development = $state<ApplicationDevelopmentResponse | null>(null);
  let developmentState = $state("idle");
  let developmentSelection = $state<{ releaseId: string; target: string; objectId: string } | null>(null);
  let capacity = $state<{
    pressure: string; activeAllocations: number; activePorts: number; projectAllocations: number;
    usage: { cpu: number; memoryMiB: number; connections: number; concurrency: number; ports: number };
    remaining: { cpu: number; memoryMiB: number; connections: number; concurrency: number; ports: number } | null;
  } | null>(null);
  let capacityState = $state("idle");
  let capacityHistory = $state<Array<{
    generatedAt: string; pressure: string; activeAllocations: number; activePorts: number;
    usage: { cpu: number; memoryMiB: number; connections: number; concurrency: number; ports: number };
  }>>([]);
  let previews = $state<PreviewRecord[]>([]);
  let previewState = $state("idle");
  let previewMutation = $state(false);
  const scope = $derived({
    ref: page.params.ref ?? "",
    application: page.url.searchParams.get("application") ?? "",
    environment: page.url.searchParams.get("environment") ?? "",
  });
  const valid = $derived(validApplicationScope(scope));

  $effect(() => {
    const selected = scope;
    application = selected.application;
    environment = selected.environment;
    cursor = undefined;
    previousCursors = [];
    developmentSelection = null;
  });
  $effect(() => {
    const selected = scope;
    void revision;
    const controller = new AbortController();
    previews = [];
    previewState = validApplicationScope(selected) ? "loading" : "idle";
    if (validApplicationScope(selected)) {
      void apiClient(`/v1/projects/${selected.ref}/applications/${selected.application}/environments/${selected.environment}/previews`, {
        signal: controller.signal,
      }).then(async response => {
        if (!response.ok) throw new Error("previews");
        const payload = await response.json() as { previews?: PreviewRecord[] };
        return Array.isArray(payload.previews) ? payload.previews : [];
      }).then(value => {
        if (!controller.signal.aborted) { previews = value; previewState = "ready"; }
      }).catch(() => {
        if (!controller.signal.aborted) previewState = "error";
      });
    }
    return () => controller.abort();
  });
  $effect(() => {
    const selected = scope;
    void revision;
    const controller = new AbortController();
    capacity = null;
    capacityHistory = [];
    capacityState = validApplicationScope(selected) ? "loading" : "idle";
    if (validApplicationScope(selected)) {
      void Promise.all([
        apiClient(`/v1/projects/${selected.ref}/capacity`, { signal: controller.signal }),
        apiClient(`/v1/projects/${selected.ref}/capacity/history?limit=12`, { signal: controller.signal }),
      ]).then(async ([response, historyResponse]) => {
        if (!response.ok || !historyResponse.ok) throw new Error("capacity");
        const value = await response.json() as unknown;
        const historyValue = await historyResponse.json() as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)
          || !("usage" in value) || !value.usage || typeof value.usage !== "object"
          || !("pressure" in value) || typeof value.pressure !== "string") {
          throw new Error("capacity");
        }
        const history = historyValue && typeof historyValue === "object" && !Array.isArray(historyValue)
          && "history" in historyValue && Array.isArray(historyValue.history) ? historyValue.history : [];
        return { value: value as NonNullable<typeof capacity>, history };
      }).then(result => {
        if (!controller.signal.aborted) {
          capacity = result.value;
          capacityHistory = result.history as typeof capacityHistory;
          capacityState = "ready";
        }
      }).catch(() => {
        if (!controller.signal.aborted) capacityState = "error";
      });
    }
    return () => controller.abort();
  });
  $effect(() => {
    const selected = scope;
    void revision;
    const controller = new AbortController();
    evidence = null;
    evidenceState = validApplicationScope(selected) ? "loading" : "idle";
    if (validApplicationScope(selected)) {
      void loadApplicationDeploymentEvidence(selected, apiClient, controller.signal).then(value => {
        if (!controller.signal.aborted) { evidence = value; evidenceState = "ready"; }
      }).catch(() => {
        if (!controller.signal.aborted) evidenceState = "error";
      });
    }
    return () => controller.abort();
  });
  $effect(() => {
    const selected = scope;
    void revision;
    const controller = new AbortController();
    runtime = null;
    runtimeState = validApplicationScope(selected) ? "loading" : "idle";
    if (validApplicationScope(selected)) {
      void loadApplicationRuntime(selected, apiClient, controller.signal).then(value => {
        if (!controller.signal.aborted) { runtime = value; runtimeState = "ready"; }
      }).catch(error => {
        if (!controller.signal.aborted) runtimeState = error instanceof ApplicationRuntimeChanged ? "changed" : "error";
      });
    }
    return () => controller.abort();
  });
  $effect(() => {
    const selected = scope;
    const selectedCursor = cursor;
    void revision;
    const controller = new AbortController();
    releases = null;
    releaseState = validApplicationScope(selected) ? "loading" : "idle";
    if (validApplicationScope(selected)) {
      void loadApplicationReleases(selected, apiClient, controller.signal, selectedCursor).then(value => {
        if (!controller.signal.aborted) { releases = value; releaseState = "ready"; }
      }).catch(() => {
        if (!controller.signal.aborted) releaseState = "error";
      });
    }
    return () => controller.abort();
  });
  $effect(() => {
    const selected = scope;
    const selection = developmentSelection;
    const controller = new AbortController();
    development = null;
    if (!validApplicationScope(selected) || !selection) {
      developmentState = "idle";
      return () => controller.abort();
    }
    developmentState = "loading";
    void loadApplicationDevelopment(selected, selection.releaseId, selection.target, apiClient, controller.signal, selection.objectId)
      .then(value => {
        if (!controller.signal.aborted) { development = value; developmentState = "ready"; }
      })
      .catch(() => {
        if (!controller.signal.aborted) developmentState = "error";
      });
    return () => controller.abort();
  });
  function select(event: SubmitEvent) {
    event.preventDefault();
    const url = new URL(page.url.href);
    url.searchParams.set("application", application.trim());
    url.searchParams.set("environment", environment.trim());
    void goto(`${url.pathname}${url.search}`, { invalidateAll: false });
  }
  function refresh() {
    untrack(() => { cursor = undefined; previousCursors = []; revision += 1; });
  }
  function inspect(releaseId: string, target: string, objectId: string) {
    developmentSelection = { releaseId, target, objectId };
  }
  async function createPreview() {
    const selected = scope;
    const releaseId = releases?.releases[0]?.release_id;
    if (!validApplicationScope(selected) || !releaseId || previewMutation) return;
    previewMutation = true;
    try {
      const response = await apiClient(`/v1/projects/${selected.ref}/applications/${selected.application}/environments/${selected.environment}/previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ release_id: releaseId, data_mode: "schema_only" }),
      });
      if (!response.ok) throw new Error("preview");
      const created = await response.json() as PreviewRecord;
      previews = [created, ...previews];
      previewState = "ready";
    } catch {
      previewState = "error";
    } finally {
      previewMutation = false;
    }
  }
  async function cleanupPreview(previewId: string) {
    const selected = scope;
    if (!validApplicationScope(selected) || previewMutation) return;
    previewMutation = true;
    try {
      const response = await apiClient(`/v1/projects/${selected.ref}/applications/${selected.application}/environments/${selected.environment}/previews/${previewId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("cleanup");
      const updated = await response.json() as PreviewRecord;
      previews = previews.map(item => item.preview_id === previewId ? updated : item);
    } catch {
      previewState = "error";
    } finally {
      previewMutation = false;
    }
  }
</script>

<svelte:head><title>{$t("Applications.title")} | SupaCloud</title></svelte:head>
<div class="space-y-6">
  <header class="flex flex-wrap items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">{$t("Applications.title")}</h1>
    <Button variant="outline" onclick={refresh} disabled={!valid} aria-label={$t("Common.refresh")} title={$t("Common.refresh")}>
      <RefreshCw class="h-4 w-4" />
    </Button>
  </header>
  <form onsubmit={select} class="flex flex-wrap items-end gap-3">
    <label class="grid min-w-0 gap-1 text-sm">{$t("Applications.application")}
      <input class="h-9 w-full rounded-md border bg-background px-3" bind:value={application} required pattern={"[A-Za-z0-9_\\-]{1,64}"} maxlength="64" name="application" />
    </label>
    <label class="grid min-w-0 gap-1 text-sm">{$t("Applications.environment")}
      <input class="h-9 w-full rounded-md border bg-background px-3" bind:value={environment} required pattern={"[A-Za-z0-9_\\-]{1,64}"} maxlength="64" name="environment" />
    </label>
    <Button type="submit">{$t("Applications.open")}</Button>
  </form>
  {#if !valid}
    <p role="status" class="text-sm text-muted-foreground">{$t("Applications.scope_required")}</p>
  {:else}
    <section class="space-y-3" aria-busy={runtimeState === "loading"}>
      <h2 class="text-base font-semibold">{$t("Applications.runtime")}</h2>
      {#if runtimeState === "loading"}<p role="status">{$t("Applications.loading")}</p>
      {:else if runtimeState === "error" || runtimeState === "changed"}
        <p role="alert">{$t(runtimeState === "changed" ? "Applications.changed" : "Applications.unavailable")}</p>
      {:else if runtime}
        {#if runtime.readiness === null}<p>{$t("Applications.no_active")}</p>
        {:else}
          <p class="text-sm font-medium">{$t(runtime.readiness.ready ? "Applications.ready" : "Applications.not_ready")}</p>
          <dl class="grid gap-2 text-sm">
            <div><dt>{$t("Applications.release")}</dt><dd class="break-all font-mono">{runtime.readiness.release_id}</dd></div>
            <div><dt>{$t("Applications.activation")}</dt><dd class="break-all font-mono">{runtime.readiness.activation_id}</dd></div>
            {#if runtime.configuration_id}<div><dt>{$t("Applications.configuration")}</dt><dd class="break-all font-mono">{runtime.configuration_id}</dd></div>{/if}
          </dl>
          <div class="overflow-x-auto">
            <table class="w-full table-fixed text-left text-sm">
              <thead><tr class="border-b"><th class="p-2">{$t("Applications.target")}</th><th class="p-2">{$t("Applications.kind")}</th><th class="p-2">{$t("Applications.status")}</th><th class="p-2">PID</th></tr></thead>
              <tbody>{#each runtime.readiness.targets as target (target.target)}
                <tr class="border-b"><td class="break-all p-2">{target.target}</td><td class="break-all p-2">{target.kind}</td><td class="break-all p-2">{target.code}</td><td class="break-all p-2">{target.pid}</td></tr>
              {/each}</tbody>
            </table>
          </div>
        {/if}
      {/if}
    </section>
    <section class="space-y-3" aria-busy={evidenceState === "loading"}>
      <h2 class="text-base font-semibold">Deployment evidence</h2>
      {#if evidenceState === "loading"}<p role="status">{$t("Applications.loading")}</p>
      {:else if evidenceState === "error"}<p role="alert">{$t("Applications.unavailable")}</p>
      {:else if evidence?.evidence === null}<p>{$t("Applications.no_evidence")}</p>
      {:else if evidence?.evidence}
        <p class="text-sm font-medium">Status: <span class="font-mono">{evidence.evidence.status}</span></p>
        <dl class="grid gap-2 text-sm sm:grid-cols-3">
          <div><dt class="text-muted-foreground">Migration</dt><dd class="font-mono">{evidence.evidence.database.migration.status}</dd></div>
          <div><dt class="text-muted-foreground">Backup</dt><dd class="font-mono">{evidence.evidence.database.backup.status}</dd></div>
          <div><dt class="text-muted-foreground">Recovery</dt><dd class="font-mono">{evidence.evidence.database.recovery.status}</dd></div>
          <div><dt class="text-muted-foreground">Authenticated smoke</dt><dd class="font-mono">{evidence.evidence.health.authenticated_smoke}</dd></div>
          <div><dt class="text-muted-foreground">Rollback</dt><dd class="font-mono">{evidence.evidence.rollback.status}</dd></div>
          <div><dt class="text-muted-foreground">Recorded</dt><dd>{evidence.evidence.recorded_at}</dd></div>
        </dl>
      {/if}
    </section>
    <section class="space-y-3" aria-busy={capacityState === "loading"}>
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-semibold">{$t("Applications.capacity")}</h2>
        {#if capacity}<span class="text-xs font-medium uppercase text-muted-foreground">{capacity.pressure}</span>{/if}
      </div>
      {#if capacityState === "loading"}<p role="status">{$t("Applications.loading")}</p>
      {:else if capacityState === "error"}<p role="alert">{$t("Applications.capacity_unavailable")}</p>
      {:else if capacity}
        <dl class="grid gap-2 text-sm sm:grid-cols-3">
          <div><dt class="text-muted-foreground">{$t("Applications.active_allocations")}</dt><dd>{capacity.activeAllocations}</dd></div>
          <div><dt class="text-muted-foreground">{$t("Applications.project_allocations")}</dt><dd>{capacity.projectAllocations}</dd></div>
          <div><dt class="text-muted-foreground">{$t("Applications.active_ports")}</dt><dd>{capacity.activePorts} / {capacity.usage.ports + (capacity.remaining?.ports ?? 0)}</dd></div>
          <div><dt class="text-muted-foreground">CPU</dt><dd>{capacity.usage.cpu} / {capacity.usage.cpu + (capacity.remaining?.cpu ?? 0)}</dd></div>
          <div><dt class="text-muted-foreground">{$t("Applications.memory")}</dt><dd>{capacity.usage.memoryMiB} MiB / {capacity.usage.memoryMiB + (capacity.remaining?.memoryMiB ?? 0)} MiB</dd></div>
          <div><dt class="text-muted-foreground">{$t("Applications.concurrency")}</dt><dd>{capacity.usage.concurrency} / {capacity.usage.concurrency + (capacity.remaining?.concurrency ?? 0)}</dd></div>
        </dl>
        <p class="text-xs text-muted-foreground">{$t("Applications.capacity_note")}</p>
        {#if capacityHistory.length > 0}
          <div class="border-t pt-3">
            <h3 class="text-sm font-semibold">{$t("Applications.capacity_history")}</h3>
            <div class="mt-2 overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead><tr class="border-b">
                  <th class="p-2">{$t("Applications.time")}</th>
                  <th class="p-2">{$t("Applications.status")}</th>
                  <th class="p-2">CPU</th>
                  <th class="p-2">{$t("Applications.memory")}</th>
                  <th class="p-2">{$t("Applications.active_ports")}</th>
                </tr></thead>
                <tbody>{#each capacityHistory.slice(0, 6) as item (item.generatedAt)}
                  <tr class="border-b">
                    <td class="p-2">{item.generatedAt}</td>
                    <td class="p-2">{item.pressure}</td>
                    <td class="p-2">{item.usage.cpu}</td>
                    <td class="p-2">{item.usage.memoryMiB} MiB</td>
                    <td class="p-2">{item.activePorts}</td>
                  </tr>
                {/each}</tbody>
              </table>
            </div>
          </div>
        {/if}
      {/if}
    </section>
    <section class="space-y-3" aria-busy={previewState === "loading"}>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-base font-semibold">{$t("Applications.previews")}</h2>
        <Button variant="outline" onclick={createPreview} disabled={previewMutation || !releases?.releases.length} title={$t("Applications.create_preview")}>
          {#if previewMutation}<Loader2 class="h-4 w-4 animate-spin" />{:else}<Plus class="h-4 w-4" />{/if}
          {$t("Applications.create_preview")}
        </Button>
      </div>
      {#if previewState === "loading"}<p role="status">{$t("Applications.loading")}</p>
      {:else if previewState === "error"}<p role="alert">{$t("Applications.preview_unavailable")}</p>
      {:else if previews.length === 0}<p class="text-sm text-muted-foreground">{$t("Applications.no_previews")}</p>
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full min-w-[720px] text-left text-sm">
            <thead><tr class="border-b">
              <th class="p-2">{$t("Applications.preview")}</th><th class="p-2">{$t("Applications.status")}</th>
              <th class="p-2">{$t("Applications.branch")}</th><th class="p-2">{$t("Applications.smoke_test")}</th><th class="p-2"></th>
            </tr></thead>
            <tbody>{#each previews as preview (preview.preview_id)}
              <tr class="border-b">
                <td class="p-2 font-mono text-xs">{preview.preview_id.slice(0, 12)}</td>
                <td class="p-2">{preview.status}</td>
                <td class="p-2 font-mono text-xs">{preview.resources.database_branch.branch_ref}</td>
                <td class="p-2">{preview.resources.smoke_test.status}</td>
                <td class="p-2 text-right">
                  <Button variant="outline" onclick={() => cleanupPreview(preview.preview_id)} disabled={previewMutation || preview.status === "cleaned"} aria-label={$t("Applications.cleanup_preview")} title={$t("Applications.cleanup_preview")}>
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </td>
              </tr>
            {/each}</tbody>
          </table>
        </div>
      {/if}
    </section>
    <section class="space-y-3" aria-busy={releaseState === "loading"}>
      <h2 class="text-base font-semibold">{$t("Applications.releases")}</h2>
      {#if releaseState === "loading"}<p role="status">{$t("Applications.loading")}</p>
      {:else if releaseState === "error"}<p role="alert">{$t("Applications.unavailable")}</p>
      {:else if releases}
        {#if releases.releases.length === 0}<p>{$t("Applications.no_releases")}</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full table-fixed text-left text-sm">
              <thead><tr class="border-b"><th class="p-2">{$t("Applications.release")}</th><th class="p-2">{$t("Applications.stored_at")}</th><th class="p-2">{$t("Applications.target")}</th><th class="p-2">{$t("Applications.development")}</th></tr></thead>
              <tbody>{#each releases.releases as release (release.release_id)}
                <tr class="border-b align-top"><td class="break-all p-2 font-mono">{release.release_id}</td><td class="break-all p-2">{release.created_at}</td><td class="break-all p-2">{release.targets.map(target => `${target.name} (${target.kind})`).join(", ")}</td>
                  <td class="p-2"><div class="flex flex-wrap gap-1">{#each release.targets as target (target.name)}
                    <Button variant="outline" disabled={developmentState === "loading"} onclick={() => inspect(release.release_id, target.name, target.object_id)}>{target.name}</Button>
                  {/each}</div></td>
                </tr>
              {/each}</tbody>
            </table>
          </div>
        {/if}
      {/if}
      <div class="flex gap-2">
        <Button variant="outline" disabled={releaseState === "loading" || previousCursors.length === 0} onclick={() => {
          cursor = previousCursors.at(-1); previousCursors = previousCursors.slice(0, -1);
        }}>{$t("Applications.previous")}</Button>
        <Button variant="outline" disabled={releaseState !== "ready" || !releases?.next_cursor} onclick={() => {
          if (releases?.next_cursor) { previousCursors = [...previousCursors, cursor]; cursor = releases.next_cursor; }
        }}>{$t("Applications.next")}</Button>
      </div>
    </section>
    {#if developmentState !== "idle"}
      <section class="space-y-3" aria-busy={developmentState === "loading"}>
        <h2 class="text-base font-semibold">{$t("Applications.development")}</h2>
        {#if developmentState === "loading"}<p role="status">{$t("Applications.loading")}</p>
        {:else if developmentState === "error"}<p role="alert">{$t("Applications.development_unavailable")}</p>
        {:else if development}
          <p class="text-sm font-medium">{$t("Applications.development_verified")}: <span class="font-mono">{development.target}</span> · <span class="break-all font-mono">{development.object_id.slice(0, 12)}</span></p>
          <p class="break-all text-sm">{$t("Applications.release")}: <span class="font-mono">{development.release_id}</span></p>
          <dl class="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <div><dt class="text-muted-foreground">{$t("Applications.modules")}</dt><dd>{development.context.modules.length}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.routes")}</dt><dd>{development.context.routes.length}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.commands")}</dt><dd>{development.context.commands.length}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.jobs")}</dt><dd>{development.context.jobs.length}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.resources")}</dt><dd>{development.context.resources.length}</dd></div>
          </dl>
          <div class="space-y-2">
            <h3 class="text-sm font-semibold">{$t("Applications.relationships")}</h3>
            {#if development.context.routes.length === 0 && development.context.jobs.length === 0}
              <p class="text-sm text-muted-foreground">{$t("Applications.no_relationships")}</p>
            {:else}
              <div class="overflow-x-auto rounded-md border">
                <table class="w-full min-w-[720px] text-left text-xs">
                  <thead class="bg-muted/50">
                    <tr>
                      <th class="p-2 font-medium">{$t("Applications.api")}</th>
                      <th class="p-2 font-medium">{$t("Applications.command")}</th>
                      <th class="p-2 font-medium">{$t("Applications.job")}</th>
                      <th class="p-2 font-medium">{$t("Applications.resources")}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y">
                    {#each development.context.routes as route (`${route.method}:${route.path}`)}
                      {@const command = route.command ? development.context.commands.find(candidate => candidate.module === route.module && candidate.name === route.command) : undefined}
                      <tr>
                        <td class="p-2 font-mono">{route.method} {route.path}</td>
                        <td class="p-2">{route.command ?? "—"}</td>
                        <td class="p-2">—</td>
                        <td class="p-2">{command?.resources.map(resource => resource.resource).join(", ") || "—"}</td>
                      </tr>
                    {/each}
                    {#each development.context.jobs as job (`job:${job.module}:${job.name}`)}
                      <tr>
                        <td class="p-2">—</td>
                        <td class="p-2">—</td>
                        <td class="p-2 font-mono">{job.module}.{job.name}</td>
                        <td class="p-2">{job.resources.map(resource => resource.resource).join(", ") || "—"}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
          <h3 class="text-sm font-semibold">{$t("Applications.diagnostics")}</h3>
          {#if development.context.diagnostics.length === 0}<p class="text-sm text-muted-foreground">{$t("Applications.no_diagnostics")}</p>
          {:else}
            <div class="overflow-x-auto">
              <table class="w-full table-fixed text-left text-sm">
                <thead><tr class="border-b"><th class="p-2">{$t("Applications.status")}</th><th class="p-2">Code</th><th class="p-2">File</th></tr></thead>
                <tbody>{#each development.context.diagnostics as diagnostic, index (index)}
                  <tr class="border-b"><td class="break-all p-2">{diagnostic.severity}</td><td class="break-all p-2 font-mono">{diagnostic.code}</td><td class="break-all p-2">{diagnostic.file ?? ""}{diagnostic.line === undefined ? "" : `:${diagnostic.line}`}</td></tr>
                {/each}</tbody>
              </table>
            </div>
          {/if}
        {/if}
      </section>
    {/if}
  {/if}
</div>
