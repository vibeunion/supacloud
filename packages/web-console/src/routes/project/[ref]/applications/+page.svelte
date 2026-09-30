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
  import {
    loadApplicationDevelopment, type ApplicationDevelopmentResponse,
  } from "$lib/application-development";
  import {
    loadReleaseEvidence, type ReleaseEvidenceResponse,
  } from "$lib/release-evidence";
  import {
    loadReleaseExecution, type ReleaseExecutionResponse,
  } from "$lib/release-execution";

  let application = $state("");
  let environment = $state("");
  let runtime = $state<RuntimeResponse | null>(null);
  let releases = $state<ReleasePage | null>(null);
  let runtimeState = $state("idle");
  let releaseState = $state("idle");
  let revision = $state(0);
  let cursor = $state<string | undefined>();
  let previousCursors = $state<(string | undefined)[]>([]);
  let development = $state<ApplicationDevelopmentResponse | null>(null);
  let developmentState = $state("idle");
  let developmentSelection = $state<{ releaseId: string; target: string } | null>(null);
  let evidence = $state<ReleaseEvidenceResponse | null>(null);
  let evidenceState = $state("idle");
  let evidenceSelection = $state<{ releaseId: string; target: string } | null>(null);
  let execution = $state<ReleaseExecutionResponse | null>(null);
  let executionState = $state("idle");
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
    evidenceSelection = null;
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
    void loadApplicationDevelopment(selected, selection.releaseId, selection.target, apiClient, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) { development = value; developmentState = "ready"; }
      })
      .catch(() => {
        if (!controller.signal.aborted) developmentState = "error";
      });
    return () => controller.abort();
  });
  $effect(() => {
    const selected = scope;
    const selection = evidenceSelection;
    const controller = new AbortController();
    evidence = null;
    if (!validApplicationScope(selected) || !selection) {
      evidenceState = "idle";
      return () => controller.abort();
    }
    evidenceState = "loading";
    void loadReleaseEvidence(selected, selection.releaseId, selection.target, apiClient, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) { evidence = value; evidenceState = "ready"; }
      })
      .catch(() => {
        if (!controller.signal.aborted) evidenceState = "error";
      });
    return () => controller.abort();
  });
  $effect(() => {
    const selected = scope;
    const selection = evidenceSelection;
    const controller = new AbortController();
    execution = null;
    if (!validApplicationScope(selected) || !selection) {
      executionState = "idle";
      return () => controller.abort();
    }
    executionState = "loading";
    void loadReleaseExecution(selected, selection.releaseId, selection.target, apiClient, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) { execution = value; executionState = "ready"; }
      })
      .catch(() => {
        if (!controller.signal.aborted) executionState = "error";
      });
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
  function inspect(releaseId: string, target: string) {
    developmentSelection = { releaseId, target };
  }
  function inspectEvidence(releaseId: string, target: string) {
    evidenceSelection = { releaseId, target };
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
              <thead><tr class="border-b"><th class="p-2">{$t("Applications.release")}</th><th class="p-2">{$t("Applications.stored_at")}</th><th class="p-2">{$t("Applications.target")}</th><th class="p-2">{$t("Applications.development")}</th><th class="p-2">{$t("Applications.evidence")}</th></tr></thead>
              <tbody>{#each releases.releases as release (release.release_id)}
                <tr class="border-b align-top"><td class="break-all p-2 font-mono">{release.release_id}</td><td class="break-all p-2">{release.created_at}</td><td class="break-all p-2">{release.targets.map(target => `${target.name} (${target.kind})`).join(", ")}</td>
                  <td class="p-2"><div class="flex flex-wrap gap-1">{#each release.targets as target (target.name)}
                    <Button variant="outline" disabled={developmentState === "loading"} onclick={() => inspect(release.release_id, target.name)}>{target.name}</Button>
                  {/each}</div></td>
                  <td class="p-2"><div class="flex flex-wrap gap-1">{#each release.targets as target (target.name)}
                    <Button variant="outline" disabled={evidenceState === "loading"} aria-label={`${$t("Applications.evidence")} ${target.name}`} onclick={() => inspectEvidence(release.release_id, target.name)}>{target.name}</Button>
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
          <dl class="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <div><dt class="text-muted-foreground">{$t("Applications.modules")}</dt><dd>{development.context.modules.length}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.routes")}</dt><dd>{development.context.routes.length}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.commands")}</dt><dd>{development.context.commands.length}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.jobs")}</dt><dd>{development.context.jobs.length}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.resources")}</dt><dd>{development.context.resources.length}</dd></div>
          </dl>
          <h3 class="text-sm font-semibold">{$t("Applications.diagnostics")}</h3>
          {#if development.context.diagnostics.length === 0}<p class="text-sm text-muted-foreground">{$t("Applications.no_diagnostics")}</p>
          {:else}
            <div class="overflow-x-auto">
              <table class="w-full table-fixed text-left text-sm">
                <thead><tr class="border-b"><th class="p-2">{$t("Applications.status")}</th><th class="p-2">Code</th><th class="p-2">File</th></tr></thead>
                <tbody>{#each development.context.diagnostics as diagnostic (diagnostic.code + (diagnostic.file ?? ""))}
                  <tr class="border-b"><td class="break-all p-2">{diagnostic.severity}</td><td class="break-all p-2 font-mono">{diagnostic.code}</td><td class="break-all p-2">{diagnostic.file ?? ""}{diagnostic.line === undefined ? "" : `:${diagnostic.line}`}</td></tr>
                {/each}</tbody>
              </table>
            </div>
          {/if}
        {/if}
      </section>
    {/if}
    {#if evidenceState !== "idle"}
      <section class="space-y-3" aria-busy={evidenceState === "loading"}>
        <h2 class="text-base font-semibold">{$t("Applications.evidence")}</h2>
        {#if evidenceState === "loading"}<p role="status">{$t("Applications.loading")}</p>
        {:else if evidenceState === "error"}<p role="alert">{$t("Applications.evidence_unavailable")}</p>
        {:else if evidence}
          <p class="text-sm font-medium">{$t("Applications.development_verified")}: <span class="font-mono">{evidence.target}</span> · <span class="break-all font-mono">{evidence.build.objectId.slice(0, 12)}</span></p>
          <dl class="grid gap-2 text-sm">
            <div><dt class="text-muted-foreground">{$t("Applications.evidence_build")}</dt><dd class="break-all font-mono">{evidence.build.manifestSha256.slice(0, 12)} · {evidence.build.entryKind} · {evidence.build.files} file(s)</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.evidence_contract")}</dt><dd>{evidence.contract.status}{evidence.contract.status === "present" ? ` · ${evidence.contract.resources} ${$t("Applications.resources")} · ${evidence.contract.diagnostics.errors}/${evidence.contract.diagnostics.warnings}` : ""}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.evidence_migrations")}</dt><dd>{evidence.migrations.status}{evidence.migrations.status === "present" ? ` · ${evidence.migrations.count} (${evidence.migrations.latestVersion})` : ""}</dd></div>
            <div><dt class="text-muted-foreground">{$t("Applications.evidence_rollback")}</dt><dd>{evidence.rollback.application}<br />{evidence.rollback.database}<br />{evidence.rollback.storage}</dd></div>
          </dl>
          <h3 class="text-sm font-semibold">{$t("Applications.execution")}</h3>
          {#if executionState === "loading"}<p role="status">{$t("Applications.loading")}</p>
          {:else if executionState === "error" || !execution}<p class="text-sm text-muted-foreground">{$t("Applications.execution_unavailable")}</p>
          {:else}
            <p class="text-sm font-medium">{$t(execution.deploymentVerified ? "Applications.execution_verified" : "Applications.execution_unverified")}</p>
            <div class="overflow-x-auto">
              <table class="w-full table-fixed text-left text-sm">
                <thead><tr class="border-b"><th class="p-2">{$t("Applications.execution_component")}</th><th class="p-2">{$t("Applications.status")}</th><th class="p-2">{$t("Applications.execution_version")}</th><th class="p-2">{$t("Applications.execution_observed_at")}</th></tr></thead>
                <tbody>{#each execution.components as component (component.name)}
                  <tr class="border-b"><td class="break-all p-2">{component.name}{component.required ? " *" : ""}</td><td class="break-all p-2">{component.status}</td><td class="break-all p-2 font-mono">{component.version ?? ""}</td><td class="break-all p-2">{component.observedAt ?? ""}</td></tr>
                {/each}</tbody>
              </table>
            </div>
          {/if}
          <div class="overflow-x-auto">
            <table class="w-full table-fixed text-left text-sm">
              <thead><tr class="border-b"><th class="p-2">{$t("Applications.evidence")}</th><th class="p-2">{$t("Applications.status")}</th></tr></thead>
              <tbody>{#each evidence.notes as note, index (index)}
                <tr class="border-b"><td class="p-2 font-mono">note</td><td class="break-all p-2">{note}</td></tr>
              {/each}</tbody>
            </table>
          </div>
        {/if}
      </section>
    {/if}
  {/if}
</div>
