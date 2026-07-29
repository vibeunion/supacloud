<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { t } from "svelte-i18n";
  import { AlertTriangle, Loader2, RefreshCw, Search, ScrollText } from "lucide-svelte";

  type LogEntry = {
    id?: string;
    timestamp?: string | number;
    event_message?: string;
    service?: string;
    severity?: string;
    metadata?: {
      service?: string;
      items?: Array<{ source?: string; severity?: string }>;
    };
  };

  const projectRef = $derived(page.params.ref);

  let logs = $state<LogEntry[]>([]);
  let selectedService = $state("all");
  let searchText = $state("");
  let timeRange = $state("1h");
  let isLoading = $state(false);
  let error = $state<string | null>(null);

  const services = [
    { value: "all", labelKey: "ProjectLogs.service_all" },
    { value: "auth", labelKey: "ProjectLogs.service_auth" },
    { value: "api", labelKey: "ProjectLogs.service_api" },
    { value: "realtime", labelKey: "ProjectLogs.service_realtime" },
    { value: "storage", labelKey: "ProjectLogs.service_storage" },
    { value: "database", labelKey: "ProjectLogs.service_database" },
    { value: "functions", labelKey: "ProjectLogs.service_functions" }
  ];
  let visibleServices = $state(services);

  const timeRanges = [
    { value: "15m", labelKey: "ProjectLogs.range_15m", milliseconds: 15 * 60 * 1000 },
    { value: "1h", labelKey: "ProjectLogs.range_1h", milliseconds: 60 * 60 * 1000 },
    { value: "24h", labelKey: "ProjectLogs.range_24h", milliseconds: 24 * 60 * 60 * 1000 },
    { value: "7d", labelKey: "ProjectLogs.range_7d", milliseconds: 7 * 24 * 60 * 60 * 1000 },
  ];

  async function fetchLogs() {
    if (!projectRef) return;
    isLoading = true;
    error = null;
    try {
      const params = new URLSearchParams({ limit: "200", service: selectedService });
      const range = timeRanges.find((item) => item.value === timeRange);
      if (range) params.set("start", new Date(Date.now() - range.milliseconds).toISOString());
      if (searchText.trim()) params.set("search", searchText.trim());
      const res = await apiClient(`/v1/projects/${projectRef}/logs?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || $t("ProjectLogs.load_failed"));
      if (Array.isArray(data.sources)) {
        visibleServices = services.filter((service) => service.value === "all" || data.sources.includes(service.value));
        if (!visibleServices.some((service) => service.value === selectedService)) selectedService = "all";
      }
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
    return entry.service || entry.metadata?.service || entry.metadata?.items?.[0]?.source || "system";
  }

  function getSeverity(entry: LogEntry): string {
    return entry.severity || entry.metadata?.items?.[0]?.severity || "info";
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
    <div class="flex flex-wrap items-center gap-2">
      <label class="relative">
        <Search size={13} class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          bind:value={searchText}
          onkeydown={(event) => event.key === "Enter" && void fetchLogs()}
          aria-label={$t("ProjectLogs.search")}
          placeholder={$t("ProjectLogs.search_placeholder")}
          class="h-9 w-56 rounded-lg border bg-background pl-8 pr-3 text-xs"
        />
      </label>
      <select
        bind:value={selectedService}
        onchange={() => void fetchLogs()}
        aria-label={$t("ProjectLogs.service_filter")}
        class="h-9 rounded-lg border bg-background px-3 text-xs"
      >
        {#each visibleServices as service (service.value)}
          <option value={service.value}>{$t(service.labelKey)}</option>
        {/each}
      </select>
      <select bind:value={timeRange} onchange={() => void fetchLogs()} aria-label={$t("ProjectLogs.time_range")} class="h-9 rounded-lg border bg-background px-3 text-xs">
        {#each timeRanges as range (range.value)}
          <option value={range.value}>{$t(range.labelKey)}</option>
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
