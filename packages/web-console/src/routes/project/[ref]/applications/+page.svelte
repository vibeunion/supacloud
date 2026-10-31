<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { t } from "svelte-i18n";
  import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-svelte";
  import Button from "@svadmin/ui/components/ui/button/button.svelte";
  import Input from "@svadmin/ui/components/ui/input/input.svelte";
  import * as Table from "@svadmin/ui/components/ui/table/index.js";
  import PagePattern from "@svadmin/ui/components/PagePattern.svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";
  import DescriptionList from "@svadmin/ui/components/content/DescriptionList.svelte";
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
<PagePattern kind="workspace" pageId="application-runtime" title={$t("Applications.title")}>
  {#snippet actions()}
    <Button variant="outline" onclick={refresh} disabled={!valid} aria-label={$t("Common.refresh")} title={$t("Common.refresh")}>
      <RefreshCw class="h-4 w-4" />
    </Button>
  {/snippet}
  {#snippet toolbar()}
    <form onsubmit={select} class="flex flex-wrap items-end gap-3">
      <label for="application-id" class="grid min-w-0 gap-1 text-sm">{$t("Applications.application")}
        <Input id="application-id" bind:value={application} required pattern={"[A-Za-z0-9_\\-]{1,64}"} maxlength={64} name="application" />
      </label>
      <label for="environment-id" class="grid min-w-0 gap-1 text-sm">{$t("Applications.environment")}
        <Input id="environment-id" bind:value={environment} required pattern={"[A-Za-z0-9_\\-]{1,64}"} maxlength={64} name="environment" />
      </label>
      <Button type="submit">{$t("Applications.open")}</Button>
    </form>
  {/snippet}
  {#if !valid}
    <DataState state="empty" title={$t("Applications.scope_required")} description="" />
  {:else}
    <section class="space-y-3" aria-busy={runtimeState === "loading"}>
      <h2 class="text-base font-semibold">{$t("Applications.runtime")}</h2>
      {#if runtimeState === "loading"}<DataState state="loading" loadingLabel={$t("Applications.loading")} />
      {:else if runtimeState === "error" || runtimeState === "changed"}
        <DataState state="error" title={$t(runtimeState === "changed" ? "Applications.changed" : "Applications.unavailable")} description="" retry={refresh} retryLabel={$t("Common.retry")} />
      {:else if runtime}
        {#if runtime.readiness === null}<DataState state="empty" title={$t("Applications.no_active")} description="" />
        {:else}
          <p class="text-sm font-medium">{$t(runtime.readiness.ready ? "Applications.ready" : "Applications.not_ready")}</p>
          <DescriptionList columns={3} items={[
            { label: $t("Applications.release"), value: runtime.readiness.release_id },
            { label: $t("Applications.activation"), value: runtime.readiness.activation_id },
            ...(runtime.configuration_id ? [{ label: $t("Applications.configuration"), value: runtime.configuration_id }] : []),
          ]} />
          <div class="min-w-0">
            <Table.Root class="w-full table-fixed text-left text-sm">
              <Table.Header><Table.Row class="border-b"><Table.Head class="p-2">{$t("Applications.target")}</Table.Head><Table.Head class="p-2">{$t("Applications.kind")}</Table.Head><Table.Head class="p-2">{$t("Applications.status")}</Table.Head><Table.Head class="p-2">PID</Table.Head></Table.Row></Table.Header>
              <Table.Body>{#each runtime.readiness.targets as target (target.target)}
                <Table.Row class="border-b"><Table.Cell class="break-all p-2">{target.target}</Table.Cell><Table.Cell class="break-all p-2">{target.kind}</Table.Cell><Table.Cell class="break-all p-2">{target.code}</Table.Cell><Table.Cell class="break-all p-2">{target.pid}</Table.Cell></Table.Row>
              {/each}</Table.Body>
            </Table.Root>
          </div>
        {/if}
      {/if}
    </section>
    <section class="space-y-3" aria-busy={evidenceState === "loading"}>
      <h2 class="text-base font-semibold">Deployment evidence</h2>
      {#if evidenceState === "loading"}<DataState state="loading" loadingLabel={$t("Applications.loading")} />
      {:else if evidenceState === "error"}<DataState state="error" title={$t("Applications.unavailable")} description="" retry={refresh} retryLabel={$t("Common.retry")} />
      {:else if evidence?.evidence === null}<DataState state="empty" title={$t("Applications.no_evidence")} description="" />
      {:else if evidence?.evidence}
        <p class="text-sm font-medium">Status: <span class="font-mono">{evidence.evidence.status}</span></p>
        <DescriptionList columns={3} items={[
          { label: "Migration", value: evidence.evidence.database.migration.status },
          { label: "Backup", value: evidence.evidence.database.backup.status },
          { label: "Recovery", value: evidence.evidence.database.recovery.status },
          { label: "Authenticated smoke", value: evidence.evidence.health.authenticated_smoke },
          { label: "Rollback", value: evidence.evidence.rollback.status },
          { label: "Recorded", value: evidence.evidence.recorded_at },
        ]} />
      {/if}
    </section>
    <section class="space-y-3" aria-busy={capacityState === "loading"}>
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-base font-semibold">{$t("Applications.capacity")}</h2>
        {#if capacity}<span class="text-xs font-medium uppercase text-muted-foreground">{capacity.pressure}</span>{/if}
      </div>
      {#if capacityState === "loading"}<DataState state="loading" loadingLabel={$t("Applications.loading")} />
      {:else if capacityState === "error"}<DataState state="error" title={$t("Applications.capacity_unavailable")} description="" retry={refresh} retryLabel={$t("Common.retry")} />
      {:else if capacity}
        <DescriptionList columns={3} items={[
          { label: $t("Applications.active_allocations"), value: capacity.activeAllocations },
          { label: $t("Applications.project_allocations"), value: capacity.projectAllocations },
          { label: $t("Applications.active_ports"), value: `${capacity.activePorts} / ${capacity.usage.ports + (capacity.remaining?.ports ?? 0)}` },
          { label: "CPU", value: `${capacity.usage.cpu} / ${capacity.usage.cpu + (capacity.remaining?.cpu ?? 0)}` },
          { label: $t("Applications.memory"), value: `${capacity.usage.memoryMiB} MiB / ${capacity.usage.memoryMiB + (capacity.remaining?.memoryMiB ?? 0)} MiB` },
          { label: $t("Applications.concurrency"), value: `${capacity.usage.concurrency} / ${capacity.usage.concurrency + (capacity.remaining?.concurrency ?? 0)}` },
        ]} />
        <p class="text-xs text-muted-foreground">{$t("Applications.capacity_note")}</p>
        {#if capacityHistory.length > 0}
          <div class="border-t pt-3">
            <h3 class="text-sm font-semibold">{$t("Applications.capacity_history")}</h3>
            <div class="mt-2 min-w-0">
              <Table.Root class="w-full text-left text-xs">
                <Table.Header><Table.Row class="border-b">
                  <Table.Head class="p-2">{$t("Applications.time")}</Table.Head>
                  <Table.Head class="p-2">{$t("Applications.status")}</Table.Head>
                  <Table.Head class="p-2">CPU</Table.Head>
                  <Table.Head class="p-2">{$t("Applications.memory")}</Table.Head>
                  <Table.Head class="p-2">{$t("Applications.active_ports")}</Table.Head>
                </Table.Row></Table.Header>
                <Table.Body>{#each capacityHistory.slice(0, 6) as item (item.generatedAt)}
                  <Table.Row class="border-b">
                    <Table.Cell class="p-2">{item.generatedAt}</Table.Cell>
                    <Table.Cell class="p-2">{item.pressure}</Table.Cell>
                    <Table.Cell class="p-2">{item.usage.cpu}</Table.Cell>
                    <Table.Cell class="p-2">{item.usage.memoryMiB} MiB</Table.Cell>
                    <Table.Cell class="p-2">{item.activePorts}</Table.Cell>
                  </Table.Row>
                {/each}</Table.Body>
              </Table.Root>
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
      {#if previewState === "loading"}<DataState state="loading" loadingLabel={$t("Applications.loading")} />
      {:else if previewState === "error"}<DataState state="error" title={$t("Applications.preview_unavailable")} description="" retry={refresh} retryLabel={$t("Common.retry")} />
      {:else if previews.length === 0}<DataState state="empty" title={$t("Applications.no_previews")} description="" />
      {:else}
        <div class="min-w-0">
          <Table.Root class="w-full min-w-[720px] text-left text-sm">
            <Table.Header><Table.Row class="border-b">
              <Table.Head class="p-2">{$t("Applications.preview")}</Table.Head><Table.Head class="p-2">{$t("Applications.status")}</Table.Head>
              <Table.Head class="p-2">{$t("Applications.branch")}</Table.Head><Table.Head class="p-2">{$t("Applications.smoke_test")}</Table.Head><Table.Head class="p-2"></Table.Head>
            </Table.Row></Table.Header>
            <Table.Body>{#each previews as preview (preview.preview_id)}
              <Table.Row class="border-b">
                <Table.Cell class="p-2 font-mono text-xs">{preview.preview_id.slice(0, 12)}</Table.Cell>
                <Table.Cell class="p-2">{preview.status}</Table.Cell>
                <Table.Cell class="p-2 font-mono text-xs">{preview.resources.database_branch.branch_ref}</Table.Cell>
                <Table.Cell class="p-2">{preview.resources.smoke_test.status}</Table.Cell>
                <Table.Cell class="p-2 text-right">
                  <Button variant="outline" onclick={() => cleanupPreview(preview.preview_id)} disabled={previewMutation || preview.status === "cleaned"} aria-label={$t("Applications.cleanup_preview")} title={$t("Applications.cleanup_preview")}>
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </Table.Cell>
              </Table.Row>
            {/each}</Table.Body>
          </Table.Root>
        </div>
      {/if}
    </section>
    <section class="space-y-3" aria-busy={releaseState === "loading"}>
      <h2 class="text-base font-semibold">{$t("Applications.releases")}</h2>
      {#if releaseState === "loading"}<DataState state="loading" loadingLabel={$t("Applications.loading")} />
      {:else if releaseState === "error"}<DataState state="error" title={$t("Applications.unavailable")} description="" retry={refresh} retryLabel={$t("Common.retry")} />
      {:else if releases}
        {#if releases.releases.length === 0}<DataState state="empty" title={$t("Applications.no_releases")} description="" />
        {:else}
          <div class="min-w-0">
            <Table.Root class="w-full table-fixed text-left text-sm">
              <Table.Header><Table.Row class="border-b"><Table.Head class="p-2">{$t("Applications.release")}</Table.Head><Table.Head class="p-2">{$t("Applications.stored_at")}</Table.Head><Table.Head class="p-2">{$t("Applications.target")}</Table.Head><Table.Head class="p-2">{$t("Applications.development")}</Table.Head></Table.Row></Table.Header>
              <Table.Body>{#each releases.releases as release (release.release_id)}
                <Table.Row class="border-b align-top"><Table.Cell class="break-all p-2 font-mono">{release.release_id}</Table.Cell><Table.Cell class="break-all p-2">{release.created_at}</Table.Cell><Table.Cell class="break-all p-2">{release.targets.map(target => `${target.name} (${target.kind})`).join(", ")}</Table.Cell>
                  <Table.Cell class="p-2"><div class="flex flex-wrap gap-1">{#each release.targets as target (target.name)}
                    <Button variant="outline" disabled={developmentState === "loading"} onclick={() => inspect(release.release_id, target.name, target.object_id)}>{target.name}</Button>
                  {/each}</div></Table.Cell>
                </Table.Row>
              {/each}</Table.Body>
            </Table.Root>
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
        {#if developmentState === "loading"}<DataState state="loading" loadingLabel={$t("Applications.loading")} />
        {:else if developmentState === "error"}
          <DataState state="error" title={$t("Applications.development_unavailable")} description="" retryLabel={$t("Common.retry")} retry={() => {
            if (developmentSelection) inspect(developmentSelection.releaseId, developmentSelection.target, developmentSelection.objectId);
          }} />
        {:else if development}
          <p class="text-sm font-medium">{$t("Applications.development_verified")}: <span class="font-mono">{development.target}</span> · <span class="break-all font-mono">{development.object_id.slice(0, 12)}</span></p>
          <p class="break-all text-sm">{$t("Applications.release")}: <span class="font-mono">{development.release_id}</span></p>
          <DescriptionList columns={3} items={[
            { label: $t("Applications.modules"), value: development.context.modules.length },
            { label: $t("Applications.routes"), value: development.context.routes.length },
            { label: $t("Applications.commands"), value: development.context.commands.length },
            { label: $t("Applications.jobs"), value: development.context.jobs.length },
            { label: $t("Applications.resources"), value: development.context.resources.length },
          ]} />
          <div class="space-y-2">
            <h3 class="text-sm font-semibold">{$t("Applications.relationships")}</h3>
            {#if development.context.routes.length === 0 && development.context.jobs.length === 0}
              <DataState state="empty" title={$t("Applications.no_relationships")} description="" />
            {:else}
              <div class="min-w-0 rounded-md border">
                <Table.Root class="w-full min-w-[720px] text-left text-xs">
                  <Table.Header class="bg-muted/50">
                    <Table.Row>
                      <Table.Head class="p-2 font-medium">{$t("Applications.api")}</Table.Head>
                      <Table.Head class="p-2 font-medium">{$t("Applications.command")}</Table.Head>
                      <Table.Head class="p-2 font-medium">{$t("Applications.job")}</Table.Head>
                      <Table.Head class="p-2 font-medium">{$t("Applications.resources")}</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body class="divide-y">
                    {#each development.context.routes as route (`${route.method}:${route.path}`)}
                      {@const command = route.command ? development.context.commands.find(candidate => candidate.module === route.module && candidate.name === route.command) : undefined}
                      <Table.Row>
                        <Table.Cell class="p-2 font-mono">{route.method} {route.path}</Table.Cell>
                        <Table.Cell class="p-2">{route.command ?? "—"}</Table.Cell>
                        <Table.Cell class="p-2">—</Table.Cell>
                        <Table.Cell class="p-2">{command?.resources.map(resource => resource.resource).join(", ") || "—"}</Table.Cell>
                      </Table.Row>
                    {/each}
                    {#each development.context.jobs as job (`job:${job.module}:${job.name}`)}
                      <Table.Row>
                        <Table.Cell class="p-2">—</Table.Cell>
                        <Table.Cell class="p-2">—</Table.Cell>
                        <Table.Cell class="p-2 font-mono">{job.module}.{job.name}</Table.Cell>
                        <Table.Cell class="p-2">{job.resources.map(resource => resource.resource).join(", ") || "—"}</Table.Cell>
                      </Table.Row>
                    {/each}
                  </Table.Body>
                </Table.Root>
              </div>
            {/if}
          </div>
          <h3 class="text-sm font-semibold">{$t("Applications.diagnostics")}</h3>
          {#if development.context.diagnostics.length === 0}<DataState state="empty" title={$t("Applications.no_diagnostics")} description="" />
          {:else}
            <div class="min-w-0">
              <Table.Root class="w-full table-fixed text-left text-sm">
                <Table.Header><Table.Row class="border-b"><Table.Head class="p-2">{$t("Applications.status")}</Table.Head><Table.Head class="p-2">Code</Table.Head><Table.Head class="p-2">File</Table.Head></Table.Row></Table.Header>
                <Table.Body>{#each development.context.diagnostics as diagnostic, index (index)}
                  <Table.Row class="border-b"><Table.Cell class="break-all p-2">{diagnostic.severity}</Table.Cell><Table.Cell class="break-all p-2 font-mono">{diagnostic.code}</Table.Cell><Table.Cell class="break-all p-2">{diagnostic.file ?? ""}{diagnostic.line === undefined ? "" : `:${diagnostic.line}`}</Table.Cell></Table.Row>
                {/each}</Table.Body>
              </Table.Root>
            </div>
          {/if}
        {/if}
      </section>
    {/if}
  {/if}
</PagePattern>
