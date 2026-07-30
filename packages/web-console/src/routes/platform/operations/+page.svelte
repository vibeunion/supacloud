<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { Loader2, Wrench, Play, RefreshCw, AlertTriangle, CheckCircle2, Server, ArrowRightLeft, Plus, Shield, Clock, Terminal } from "lucide-svelte";
  import { t } from "svelte-i18n";

  interface Operation {
    id: string;
    name: string;
    desc: string;
    icon: typeof import('lucide-svelte').RefreshCw;
    danger: boolean;
    fields: { key: string; label: string; placeholder: string; required: boolean }[];
    action: (params: Record<string, string>) => Promise<string>;
  }

  interface HealthReport {
    status: "OK" | "WARN" | "ERROR";
    component: string;
    message: string;
  }

  let activeOp: string | null = $state.raw(null);
  let opParams: Record<string, string> = $state.raw({});
  let isExecuting = $state(false);
  let logs: { time: string; op: string; result: string; success: boolean }[] = $state.raw([]);

  // Health Check
  let healthStatus: HealthReport[] | null = $state.raw(null);
  let isCheckingHealth = $state(false);

  const HEALTH_MESSAGE_KEYS: Record<string, string> = {
    Running: "PlatformOperations.service_running",
    "Service stopped": "PlatformOperations.service_stopped",
    "System not booted by Systemd": "PlatformOperations.systemd_unavailable",
    "Generic PostgreSQL profile active; Pigsty not configured": "PlatformOperations.generic_postgres_profile",
    "Cloud-native storage backend not mounted": "PlatformOperations.storage_not_mounted",
    "Cannot detect storage mount status": "PlatformOperations.storage_mount_unknown",
    "Cannot get disk info": "PlatformOperations.disk_info_unavailable",
    "Database not accepting connections": "PlatformOperations.database_unavailable",
    "Cannot access service status": "PlatformOperations.service_status_unavailable",
    "Standard Mode (Local Storage)": "PlatformOperations.standard_local_storage",
  };

    
  async function apiCall(url: string, method: string = "GET", body?: unknown): Promise<Record<string, unknown>> {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await apiClient(url, opts);
    return await res.json();
  }

  function isHealthReportList(payload: unknown): payload is HealthReport[] {
    return Array.isArray(payload) && payload.every((report) => (
      report
      && typeof report === "object"
      && ["OK", "WARN", "ERROR"].includes((report as HealthReport).status)
      && typeof (report as HealthReport).component === "string"
      && typeof (report as HealthReport).message === "string"
    ));
  }

  const OPERATIONS: Operation[] = $derived([
    {
      id: "reload",
      name: $t("PlatformOperations.reload_configuration"),
      desc: $t("PlatformOperations.reload_postgresql_configuration_postgresqlconf_without"),
      icon: RefreshCw,
      danger: false,
      fields: [
        { key: "ip", label: $t("PlatformOperations.node_ip"), placeholder: "127.0.0.1", required: true },
      ],
      action: async (params) => {
        const data = await apiCall("/v1/maintenance/reload", "POST", { ip: params.ip });
        return String(data.message || JSON.stringify(data));
      }
    },
    {
      id: "switchover",
      name: $t("PlatformOperations.primary_switchover"),
      desc: $t("PlatformOperations.switch_the_primary_to_a"),
      icon: ArrowRightLeft,
      danger: true,
      fields: [
        { key: "cluster", label: $t("PlatformOperations.cluster_name"), placeholder: "db-main", required: false },
        { key: "candidate", label: $t("PlatformOperations.candidate_replica"), placeholder: $t("PlatformOperations.leave_blank_to_autoselect"), required: false },
      ],
      action: async (params) => {
        const data = await apiCall("/v1/maintenance/switchover", "POST", {
          cluster: params.cluster || "db-main",
          candidate: params.candidate || undefined
        });
        return String(data.message || JSON.stringify(data));
      }
    },
    {
      id: "add_replica",
      name: $t("PlatformOperations.add_replica"),
      desc: $t("PlatformOperations.add_a_new_node_as"),
      icon: Plus,
      danger: false,
      fields: [
        { key: "ip", label: $t("PlatformOperations.new_node_ip"), placeholder: "10.10.10.12", required: true },
      ],
      action: async (params) => {
        const data = await apiCall("/v1/maintenance/replicas", "POST", { ip: params.ip });
        return String(data.message || JSON.stringify(data));
      }
    },
  ]);

  async function executeOp(op: Operation) {
    // Validate required fields
    for (const field of op.fields) {
      if (field.required && !opParams[field.key]?.trim()) {
        addLog(op.name, `❌ ${$t("PlatformOperations.please_fill_in")} ${field.label}`, false);
        return;
      }
    }
    if (op.danger && !confirm(`⚠️ ${$t("PlatformOperations.dangerous_operation_confirmation")}\n\n${$t("PlatformOperations.about_to_execute")}「${op.name}」\n${op.desc}\n\n${$t("PlatformOperations.continue")}`)) return;

    isExecuting = true;
    try {
      const result = await op.action(opParams);
      addLog(op.name, result, true);
    } catch (err: unknown) {
      addLog(op.name, (err instanceof Error ? err.message : String(err)), false);
    } finally {
      isExecuting = false;
    }
  }

  function addLog(operation: string, message: string, success: boolean) {
    logs = [{ time: new Date().toLocaleString(), op: operation, result: message, success }, ...logs].slice(0, 50);
  }

  async function checkHealth() {
    isCheckingHealth = true;
    try {
      const response = await apiClient("/monitor/health");
      const payload: unknown = await response.json();
      if (!response.ok || !isHealthReportList(payload)) throw new Error($t("PlatformOperations.health_check_failed"));
      healthStatus = payload;
      addLog($t("PlatformOperations.health_check_1"), $t("PlatformOperations.completed"), true);
    } catch (err: unknown) {
      addLog($t("PlatformOperations.health_check_1"), (err instanceof Error ? err.message : String(err)), false);
    }
    isCheckingHealth = false;
  }

  function selectOp(id: string) {
    activeOp = activeOp === id ? null : id;
    opParams = {};
  }

  function healthStatusLabel(status: HealthReport["status"]): string {
    const labels: Record<HealthReport["status"], string> = {
      OK: "PlatformOperations.health_ok",
      WARN: "PlatformOperations.health_warning",
      ERROR: "PlatformOperations.health_error",
    };
    return $t(labels[status]);
  }

  function localizeHealthComponent(component: string) {
    const map: Record<string, string> = {
      "Storage Space": $t("PlatformOperations.storage_space"),
      "Memory Status": $t("PlatformOperations.memory_status"),
      "Management API": $t("PlatformOperations.supacloud_management_api"),
      "Pigsty Infrastructure": $t("PlatformOperations.pigsty_infrastructure"),
      "Database Infrastructure": $t("PlatformOperations.database_infrastructure"),
      "Database (PostgreSQL)": $t("PlatformOperations.database_postgresql"),
      "Cloud-native Storage": $t("PlatformOperations.cloudnative_storage"),
      "Cloud-native Storage (JuiceFS)": $t("PlatformOperations.cloudnative_storage_juicefs"),
      "Database Connection": $t("PlatformOperations.database_connection"),
      "Database Cluster (HA)": $t("PlatformOperations.database_cluster_ha"),
      "Pigsty Engine": $t("PlatformOperations.pigsty_engine")
    };
    return map[component] || component;
  }

  function localizeDatabaseHealthMessage(message: string): string | null {

    const postgresReady = /^PostgreSQL (.+?) ready \(Active replicas: (\d+)\)$/.exec(message);
    if (postgresReady) {
      return $t("PlatformOperations.postgresql_ready", { values: { version: postgresReady[1], replicas: postgresReady[2] } });
    }

    const pigstyReady = /^Ready \(pig version (v?\S+) (\S+)\)$/i.exec(message);
    if (pigstyReady) {
      const version = pigstyReady[1].startsWith("v") ? pigstyReady[1] : `v${pigstyReady[1]}`;
      const platform = pigstyReady[2].replace(/^linux\//i, "Linux/");
      return $t("PlatformOperations.pigsty_ready", { values: { version, platform } });
    }

    const standalonePostgres = /^PG (.*?) running in single-node mode$/.exec(message);
    if (standalonePostgres) return $t("PlatformOperations.postgresql_single_node", { values: { version: standalonePostgres[1] } });

    return null;
  }

  function localizeResourceHealthMessage(message: string): string | null {
    const availableSpace = /^Available:\s*(.*)/.exec(message);
    if (availableSpace) return $t("PlatformOperations.available_space", { values: { value: availableSpace[1] } });
    const mountedStorage = /^Mounted:\s*(.*)/.exec(message);
    if (mountedStorage) return $t("PlatformOperations.mounted_storage", { values: { value: mountedStorage[1] } });
    const memoryStatus = /^Free (.*?) \/ Total (.*?)$/.exec(message);
    if (memoryStatus) return $t("PlatformOperations.memory_available", { values: { free: memoryStatus[1], total: memoryStatus[2] } });
    const readyDetail = /^Ready \((.+?)\)$/.exec(message);
    if (readyDetail) return $t("PlatformOperations.ready_detail", { values: { detail: readyDetail[1] } });

    return null;
  }

  function localizeHealthMessage(message: string): string {
    const exactMessageKey = HEALTH_MESSAGE_KEYS[message];
    if (exactMessageKey) return $t(exactMessageKey);
    return localizeDatabaseHealthMessage(message) || localizeResourceHealthMessage(message) || message;
  }

  onMount(() => checkHealth());
</script>

<div class="space-y-4 pb-24">
  <div class="flex items-center justify-between">
    <div>
      <h2 class="text-xl font-bold">{$t("PlatformOperations.operations")}</h2>
      <p class="text-xs text-muted-foreground mt-1">{$t("PlatformOperations.curated_pigsty_patroni_operations_executed")}</p>
    </div>
  </div>

  <!-- Health Check Panel -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Shield size={16} /> {$t("PlatformOperations.cluster_health_check")}</h3>
      <button onclick={checkHealth} disabled={isCheckingHealth} class="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
        {#if isCheckingHealth}<Loader2 size={12} class="animate-spin" />{:else}<RefreshCw size={12} />{/if}
        {$t("PlatformOperations.run_check")}
      </button>
    </div>
    <div class="p-4">
      {#if !healthStatus}
        <p class="text-xs text-muted-foreground">{$t("PlatformOperations.health_check_in_progress")}</p>
      {:else}
        <div class="grid grid-cols-2 gap-3 md:grid-cols-3">
          {#each healthStatus as report (report.component)}
            <div class="rounded-lg border p-3 flex flex-col justify-between">
              <div class="text-[10px] font-bold uppercase text-muted-foreground mb-1">{localizeHealthComponent(report.component)}</div>
              <div class="mt-1">
                <span class="text-xs font-bold px-1.5 py-0.5 rounded-sm {report.status === 'OK' ? 'bg-green-100 text-green-700' : report.status === 'ERROR' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700'}">
                  {healthStatusLabel(report.status)}
                </span>
              </div>
              <div class="text-xs text-muted-foreground mt-2 line-clamp-2" title={localizeHealthMessage(report.message)}>
                {localizeHealthMessage(report.message)}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Operations Cards -->
  <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
    {#each OPERATIONS as op (op.id)}
      {@const Icon = op.icon}
      <div class="rounded-xl border bg-card overflow-hidden {activeOp === op.id ? 'ring-2 ring-brand' : ''}">
        <button
          onclick={() => selectOp(op.id)}
          class="w-full text-left border-b px-5 py-4 hover:bg-muted/20 transition-colors"
        >
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-lg flex items-center justify-center {op.danger ? 'bg-red-500/10 text-red-500' : 'bg-brand/10 text-brand'}">
              <Icon size={20} />
            </div>
            <div>
              <div class="flex items-center gap-2">
                <span class="text-sm font-bold">{op.name}</span>
                {#if op.danger}
                  <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-red-500/10 text-red-600 border border-red-500/20">{$t("PlatformOperations.danger")}</span>
                {/if}
              </div>
              <p class="text-[10px] text-muted-foreground mt-0.5">{op.desc}</p>
            </div>
          </div>
        </button>

        {#if activeOp === op.id}
          <div class="p-4 space-y-3">
            {#each op.fields as field (field.key)}
              <div>
                <label for="op-{op.id}-{field.key}" class="text-xs font-semibold text-muted-foreground block mb-1">
                  {field.label} {#if field.required}<span class="text-red-500">*</span>{/if}
                </label>
                <input id="op-{op.id}-{field.key}"
                  bind:value={opParams[field.key]}
                  placeholder={field.placeholder}
                  class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
            {/each}
            <button
              onclick={() => executeOp(op)}
              disabled={isExecuting}
              class="w-full px-4 py-2 text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 disabled:opacity-50
                {op.danger ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-brand text-white hover:bg-brand/90'}"
            >
              {#if isExecuting}<Loader2 size={14} class="animate-spin" />{:else}<Play size={14} />{/if}
              {$t("PlatformOperations.execute")}
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <!-- Operation Logs -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Terminal size={16} /> {$t("PlatformOperations.operation_logs")}</h3>
      {#if logs.length > 0}
        <button onclick={() => logs = []} class="text-[10px] text-muted-foreground hover:text-foreground">{$t("PlatformOperations.clear")}</button>
      {/if}
    </div>
    {#if logs.length === 0}
      <div class="p-8 text-center text-muted-foreground text-xs">{$t("PlatformOperations.no_operations_have_been_executed")}</div>
    {:else}
      <div class="overflow-auto max-h-64">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2 font-semibold text-muted-foreground w-20">{$t("PlatformOperations.time")}</th>
              <th class="px-3 py-2 font-semibold text-muted-foreground w-24">{$t("PlatformOperations.operation")}</th>
              <th class="px-3 py-2 font-semibold text-muted-foreground w-12">{$t("PlatformOperations.status")}</th>
              <th class="px-3 py-2 font-semibold text-muted-foreground">{$t("PlatformOperations.result")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20 font-mono">
            {#each logs as log (`${log.time}-${log.op}-${log.result}-${log.success}`)}
              <tr class="hover:bg-muted/10">
                <td class="px-4 py-2 text-muted-foreground">{log.time}</td>
                <td class="px-3 py-2 font-medium">{log.op}</td>
                <td class="px-3 py-2">
                  {#if log.success}<CheckCircle2 size={14} class="text-green-500" />{:else}<AlertTriangle size={14} class="text-red-500" />{/if}
                </td>
                <td class="px-3 py-2 text-muted-foreground truncate max-w-sm">{log.result}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Wrench size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <div class="text-xs text-blue-700">
      <b>{$t("PlatformOperations.safety_note")}</b>{$t("PlatformOperations.only_safetyreviewed_operations_are_exposed")} {$t("PlatformOperations.all_actions_are_logged_above")}
    </div>
  </div>
</div>
