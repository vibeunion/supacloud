<script lang="ts">
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { untrack } from "svelte";
  import { t } from "svelte-i18n";
  import { RefreshCw } from "lucide-svelte";
  import Button from "@svadmin/ui/components/ui/button/button.svelte";
  import { apiClient } from "$lib/api";
  import {
    ApplicationRuntimeChanged, validApplicationScope, loadApplicationRuntime, loadApplicationReleases,
    type RuntimeResponse, type ReleasePage,
  } from "$lib/application-dashboard";

  let application = $state("");
  let environment = $state("");
  let runtime = $state<RuntimeResponse | null>(null);
  let releases = $state<ReleasePage | null>(null);
  let runtimeState = $state("idle");
  let releaseState = $state("idle");
  let revision = $state(0);
  let cursor = $state<string | undefined>();
  let previousCursors = $state<(string | undefined)[]>([]);
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
  function select(event: SubmitEvent) {
    event.preventDefault();
    const url = new URL(page.url);
    url.searchParams.set("application", application.trim());
    url.searchParams.set("environment", environment.trim());
    void goto(`${url.pathname}${url.search}`, { noScroll: true });
  }
  function refresh() {
    untrack(() => { cursor = undefined; previousCursors = []; revision += 1; });
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
    <section class="space-y-3" aria-busy={releaseState === "loading"}>
      <h2 class="text-base font-semibold">{$t("Applications.releases")}</h2>
      {#if releaseState === "loading"}<p role="status">{$t("Applications.loading")}</p>
      {:else if releaseState === "error"}<p role="alert">{$t("Applications.unavailable")}</p>
      {:else if releases}
        {#if releases.releases.length === 0}<p>{$t("Applications.no_releases")}</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full table-fixed text-left text-sm">
              <thead><tr class="border-b"><th class="p-2">{$t("Applications.release")}</th><th class="p-2">{$t("Applications.stored_at")}</th><th class="p-2">{$t("Applications.target")}</th></tr></thead>
              <tbody>{#each releases.releases as release (release.release_id)}
                <tr class="border-b align-top"><td class="break-all p-2 font-mono">{release.release_id}</td><td class="break-all p-2">{release.created_at}</td><td class="break-all p-2">{release.targets.map(target => `${target.name} (${target.kind})`).join(", ")}</td></tr>
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
  {/if}
</div>
