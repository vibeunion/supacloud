<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
  import { AlertTriangle, Loader2, RefreshCw, ScrollText } from "lucide-svelte";

  type LogEntry = {
    id?: string;
    timestamp?: string | number;
    event_message?: string;
    metadata?: {
      service?: string;
      items?: Array<{ source?: string; severity?: string }>;
    };
  };

  const projectRef = $derived(page.params.ref);

  let logs = $state<LogEntry[]>([]);
  let selectedService = $state("all");
  let isLoading = $state(false);
  let error = $state<string | null>(null);

  const services = [
    { value: "all", label: "All" },
    { value: "auth", label: "Auth" },
    { value: "api", label: "PostgREST" },
    { value: "realtime", label: "Realtime" },
    { value: "storage", label: "Storage" },
    { value: "database", label: "Database" }
  ];

  async function fetchLogs() {
    if (!projectRef) return;
    isLoading = true;
    error = null;
    try {
      const params = new URLSearchParams({ limit: "200", service: selectedService });
      const res = await apiClient(`/v1/projects/${projectRef}/logs?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load logs");
      logs = Array.isArray(data.result) ? data.result : [];
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      isLoading = false;
    }
  }

  function formatTimestamp(value: LogEntry["timestamp"]): string {
    if (!value) return "-";
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function getService(entry: LogEntry): string {
    return entry.metadata?.service || entry.metadata?.items?.[0]?.source || "system";
  }

  function getSeverity(entry: LogEntry): string {
    return entry.metadata?.items?.[0]?.severity || "info";
  }

  onMount(() => {
    void fetchLogs();
  });
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div>
      <h1 class="text-2xl font-bold flex items-center gap-2">
        <ScrollText size={24} class="text-brand" />
        {$t("Navigation.logs")}
      </h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("ProjectLogs.subtitle")}</p>
    </div>
    <div class="flex items-center gap-2">
      <select
        bind:value={selectedService}
        onchange={() => void fetchLogs()}
        class="h-9 rounded-lg border bg-background px-3 text-xs"
      >
        {#each services as service (service.value)}
          <option value={service.value}>{service.label}</option>
        {/each}
      </select>
      <button
        onclick={() => void fetchLogs()}
        disabled={isLoading}
        class="h-9 inline-flex items-center gap-2 rounded-lg border px-3 text-xs font-medium hover:bg-muted/50 disabled:opacity-50"
      >
        <RefreshCw size={14} class={isLoading ? "animate-spin" : ""} />
        {$t("Common.refresh")}
      </button>
    </div>
  </div>

  {#if error}
    <div class="rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive flex items-start gap-2">
      <AlertTriangle size={16} class="mt-0.5 shrink-0" />
      <span>{error}</span>
    </div>
  {/if}

  <div class="flex-1 overflow-hidden rounded-lg border bg-card">
    {#if isLoading && logs.length === 0}
      <div class="h-full min-h-80 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 size={28} class="animate-spin text-brand opacity-60" />
        <p class="text-xs font-mono uppercase tracking-widest">{$t("ProjectLogs.loading")}</p>
      </div>
    {:else if logs.length === 0}
      <div class="h-full min-h-80 flex flex-col items-center justify-center gap-3 text-muted-foreground">
        <ScrollText size={36} class="opacity-30" />
        <p class="text-sm">{$t("ProjectLogs.empty")}</p>
      </div>
    {:else}
      <div class="h-full overflow-auto divide-y">
        {#each logs as entry, index (entry.id || `${entry.timestamp}-${index}`)}
          <div class="grid grid-cols-1 gap-2 px-4 py-3 text-xs hover:bg-muted/30 md:grid-cols-[minmax(150px,220px)_110px_1fr] md:gap-3">
            <div class="font-mono text-muted-foreground whitespace-nowrap">{formatTimestamp(entry.timestamp)}</div>
            <div class="flex items-center gap-2">
              <span class="rounded bg-muted px-2 py-0.5 font-mono uppercase text-[10px]">{getService(entry)}</span>
              {#if getSeverity(entry) !== "info"}
                <span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] uppercase text-amber-600">{getSeverity(entry)}</span>
              {/if}
            </div>
            <pre class="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{entry.event_message || ""}</pre>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
