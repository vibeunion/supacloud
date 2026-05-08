<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Activity, Server, Pause, RotateCw, Trash2, AlertTriangle, Globe, CheckCircle2, XCircle } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { AutoForm } from "@svadmin/ui";
  import { useShow } from "@svadmin/core";
  import { useQueryClient, createMutation, createQuery } from "@tanstack/svelte-query";

  let actionInProgress = $state<string | null>(null);
  let actionMsg = $state<string | null>(null);
  let customDomainInput = $state("");
  let apiDomainInput = $state("");
  let studioDomainInput = $state("");

  // Custom domain state
  let domainHostname = $state("");
  let domainStatus = $state("not_configured");
  let newDomain = $state("");
  let domainError = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);

  const query = useShow({
    get resource() { return "v1/projects"; },
    get id() { return projectRef; }
  });

  const project = $derived(query.data?.data || null);
  const isLoading = $derived(query.isLoading);
  const routingConfig = $derived(
    ((project as Record<string, unknown> | null)?.config as Record<string, unknown> | undefined) || {}
  );
  const projectApiUrl = $derived(
    ((project as Record<string, unknown> | null)?.api as Record<string, unknown> | undefined)?.url as string
      || (routingConfig?.api_domain ? `https://${routingConfig.api_domain}` : "")
      || (routingConfig?.custom_domain ? `https://${routingConfig.custom_domain}` : "")
  );
  const projectStudioUrl = $derived(
    ((project as Record<string, unknown> | null)?.studio as Record<string, unknown> | undefined)?.url as string
      || (routingConfig?.studio_domain ? `https://${routingConfig.studio_domain}` : "")
      || (typeof window !== 'undefined' ? `${window.location.origin}/project/${projectRef}` : "")
  );

  const queryClient = useQueryClient();

  $effect(() => {
    customDomainInput = typeof routingConfig?.custom_domain === "string" ? routingConfig.custom_domain : "";
    apiDomainInput = typeof routingConfig?.api_domain === "string" ? routingConfig.api_domain : "";
    studioDomainInput = typeof routingConfig?.studio_domain === "string" ? routingConfig.studio_domain : "";
  });

  async function refetchProject() {
    await queryClient.invalidateQueries({ queryKey: ["v1/projects", "getOne", projectRef] });
  }

  function normalizeDomainValue(value: string) {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  const routingMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          custom_domain: normalizeDomainValue(customDomainInput),
          api_domain: normalizeDomainValue(apiDomainInput),
          studio_domain: normalizeDomainValue(studioDomainInput),
        }),
      });
      if (!res.ok) {
        let message = "保存 Routing 配置失败";
        try {
          const err = await res.json();
          message = err?.message || err?.error || message;
        } catch {}
        throw new Error(message);
      }
      return res.json();
    },
    onMutate: () => {
      actionInProgress = "routing";
    },
    onSuccess: async () => {
      actionMsg = "✅ Routing 配置已保存";
      await queryClient.invalidateQueries({ queryKey: ["custom_hostname", projectRef] });
      await refetchProject();
    },
    onError: (err: unknown) => {
      actionMsg = `❌ ${err instanceof Error ? err.message : "保存 Routing 配置失败"}`;
    },
    onSettled: () => {
      actionInProgress = null;
      setTimeout(() => actionMsg = null, 4000);
    }
  }));

  function saveRoutingSettings() {
    routingMutation.mutate();
  }

  const projectActionMutation = createMutation(() => ({
    mutationFn: async (action: 'restart' | 'pause' | 'restore') => {
      const res = await apiClient(`/v1/projects/${projectRef}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error(`${action} failed`);
      await new Promise(r => setTimeout(r, action === "pause" ? 1000 : 2000));
      return action;
    },
    onMutate: (action) => {
      actionInProgress = action;
    },
    onSuccess: (action) => {
      const msgs = { restart: "✅ 项目重启请求已发送", pause: "✅ 项目已暂停", restore: "✅ 项目已恢复" };
      actionMsg = msgs[action];
      refetchProject();
    },
    onError: (err, action) => {
      const msgs = { restart: "❌ 重启失败", pause: "❌ 暂停失败", restore: "❌ 恢复失败" };
      actionMsg = msgs[action];
    },
    onSettled: () => {
      actionInProgress = null;
      setTimeout(() => actionMsg = null, 4000);
    }
  }));

  function restartProject() {
    projectActionMutation.mutate('restart');
  }

  function pauseProject() {
    if (!confirm("确定要暂停项目？暂停后所有服务将停止。")) return;
    projectActionMutation.mutate('pause');
  }

  function restoreProject() {
    projectActionMutation.mutate('restore');
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      return true;
    },
    onMutate: () => { actionInProgress = "delete"; },
    onSuccess: () => {
      actionMsg = "✅ 项目已删除。正在跳转...";
      setTimeout(() => { window.location.href = "/"; }, 2000);
    },
    onError: () => {
      actionMsg = "❌ 删除失败";
    },
    onSettled: () => { actionInProgress = null; }
  }));

  function deleteProject() {
    const input = prompt(`请输入项目名称以确认删除：\n[ ${project?.name} ]`);
    if (input !== project?.name) {
      actionMsg = "❌ 项目名称不匹配，已取消删除";
      setTimeout(() => actionMsg = null, 4000);
      return;
    }
    if (!confirm("再次确认：所有数据（数据库、存储、认证用户）都将被永久删除。此操作不可撤销！")) return;
    deleteMutation.mutate();
  }

  // --- Custom Domain ---
  const domainQuery = createQuery(() => ({
    queryKey: ["custom_hostname", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`);
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    retry: false
  }));

  $effect(() => {
    if (domainQuery.data) {
      domainHostname = domainQuery.data.custom_hostname || "";
      domainStatus = domainQuery.data.status || "not_configured";
    } else if (domainQuery.isError) {
      domainHostname = "";
      domainStatus = "not_configured";
    }
  });

  const addDomainMutation = createMutation(() => ({
    mutationFn: async (hostname: string) => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ custom_hostname: hostname })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add domain");
      }
      return hostname;
    },
    onSuccess: () => {
      toast.success("Custom domain added successfully");
      newDomain = "";
      domainError = null;
      queryClient.invalidateQueries({ queryKey: ["custom_hostname", projectRef] });
      refetchProject();
    },
    onError: (err: unknown) => {
      domainError = err instanceof Error ? err.message : "Network error";
    }
  }));

  function addDomain() {
    if (!newDomain.trim()) return;
    addDomainMutation.mutate(newDomain.trim());
  }

  const removeDomainMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/custom-hostname`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      return true;
    },
    onSuccess: () => {
      toast.success("Custom domain removed");
      queryClient.invalidateQueries({ queryKey: ["custom_hostname", projectRef] });
      refetchProject();
    }
  }));

  function removeDomain() {
    if (!confirm(`Remove custom domain "${domainHostname}"?`)) return;
    removeDomainMutation.mutate();
  }
  const domainLoading = $derived(domainQuery.isPending || addDomainMutation.isPending || removeDomainMutation.isPending);
</script>

<div class="flex flex-col space-y-6">

  {#if actionMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">
      {actionMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if project}
    <div class="space-y-6">
      <!-- General via svadmin AutoForm -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <h2 class="text-lg font-semibold">{$t("Settings.general")}</h2>
        <AutoForm resourceName="v1/projects" id={projectRef} />
      </div>

      <!-- API & Access URLs -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <h2 class="text-lg font-semibold">API 地址</h2>
        <div class="space-y-3 text-sm">
          {#if Object.keys(routingConfig).length > 0}
            {#if routingConfig?.custom_domain}
              <div>
                <span class="text-xs text-muted-foreground">自定义域名 (Custom Domain)</span>
                <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{String(routingConfig.custom_domain)}</p>
              </div>
            {/if}
            {#if routingConfig?.api_domain}
              <div>
                <span class="text-xs text-muted-foreground">API Domain</span>
                <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{String(routingConfig.api_domain)}</p>
              </div>
            {/if}
            {#if routingConfig?.studio_domain}
              <div>
                <span class="text-xs text-muted-foreground">Studio Domain</span>
                <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{String(routingConfig.studio_domain)}</p>
              </div>
            {/if}
            <div>
              <span class="text-xs text-muted-foreground">API URL</span>
              <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{projectApiUrl || "N/A"}</p>
            </div>
            {#if routingConfig?.postgrest_port}
              <div>
                <span class="text-xs text-muted-foreground">PostgREST Port</span>
                <p class="font-mono text-xs">{String(routingConfig.postgrest_port)}</p>
              </div>
            {/if}
            {#if routingConfig?.gotrue_port}
              <div>
                <span class="text-xs text-muted-foreground">GoTrue Port</span>
                <p class="font-mono text-xs">{String(routingConfig.gotrue_port)}</p>
              </div>
            {/if}
          {:else}
            <div>
              <span class="text-xs text-muted-foreground">API URL</span>
              <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{projectApiUrl || "N/A"}</p>
            </div>
          {/if}
          <div>
            <span class="text-xs text-muted-foreground">Studio URL</span>
            <p class="font-mono text-xs bg-muted/50 rounded px-3 py-2 mt-1 select-all">{projectStudioUrl || "N/A"}</p>
          </div>
        </div>
      </div>

      <div class="border rounded-xl bg-card p-6 space-y-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="text-lg font-semibold">Routing / Domains</h2>
            <p class="text-xs text-muted-foreground mt-1">
              修改 API、Studio 和主域名绑定。保存后会自动刷新项目运行时配置。
            </p>
          </div>
          <button
            onclick={saveRoutingSettings}
            disabled={routingMutation.isPending}
            class="px-4 py-2 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {#if routingMutation.isPending}
              <Loader2 size={14} class="animate-spin" />
            {/if}
            保存
          </button>
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <label class="space-y-2">
            <span class="text-xs text-muted-foreground">Custom Domain</span>
            <input
              type="text"
              bind:value={customDomainInput}
              placeholder="e.g. app.example.com"
              class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 font-mono"
            />
          </label>

          <label class="space-y-2">
            <span class="text-xs text-muted-foreground">API Domain</span>
            <input
              type="text"
              bind:value={apiDomainInput}
              placeholder="e.g. api.example.com"
              class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 font-mono"
            />
          </label>

          <label class="space-y-2">
            <span class="text-xs text-muted-foreground">Studio Domain</span>
            <input
              type="text"
              bind:value={studioDomainInput}
              placeholder="e.g. studio.example.com"
              class="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 font-mono"
            />
          </label>
        </div>
      </div>

      <!-- Custom Domain -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <Globe size={16} />
            Custom Domain
          </h2>
          {#if domainHostname}
            <span class="text-[10px] px-2.5 py-1 rounded-full bg-green-500/10 text-green-600 font-semibold flex items-center gap-1">
              <CheckCircle2 size={10} /> Active
            </span>
          {/if}
        </div>

        {#if domainHostname}
          <!-- Current domain -->
          <div class="rounded-lg border bg-background p-4 space-y-3">
            <div>
              <span class="text-xs text-muted-foreground">Current Domain</span>
              <p class="font-mono text-sm font-semibold mt-1">{domainHostname}</p>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div class="rounded-lg bg-muted/30 p-3">
                <span class="text-muted-foreground">API Endpoint</span>
                <p class="font-mono mt-1 select-all">https://{domainHostname}</p>
              </div>
              <div class="rounded-lg bg-muted/30 p-3">
                <span class="text-muted-foreground">Auth Endpoint</span>
                <p class="font-mono mt-1 select-all">https://{domainHostname}/auth/v1</p>
              </div>
            </div>
            <div class="pt-2 border-t">
              <button onclick={removeDomain} disabled={domainLoading}
                class="text-xs text-destructive hover:text-destructive/80 font-medium transition-colors disabled:opacity-50">
                {#if domainLoading}<Loader2 size={12} class="animate-spin inline mr-1" />{/if}
                Remove Domain
              </button>
            </div>
          </div>

          <!-- DNS Instructions -->
          <div class="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 space-y-2">
            <h3 class="text-xs font-semibold text-amber-700">DNS Configuration Required</h3>
            <p class="text-[10px] text-muted-foreground">Add the following DNS records to your domain registrar:</p>
            <div class="font-mono text-[11px] bg-background rounded p-3 space-y-1 select-all">
              <div>A&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{domainHostname}&nbsp;&nbsp;→&nbsp;&nbsp;82.157.196.165</div>
            </div>
          </div>
        {:else}
          <!-- Add domain form -->
          <div class="space-y-3">
            <p class="text-xs text-muted-foreground">Bind a custom domain for your project API. TLS certificates are managed through Kong certificates/SNI.</p>
            <div class="flex gap-2">
              <input type="text" bind:value={newDomain} placeholder="e.g. api.example.com"
                class="flex-1 px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 font-mono"
                onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && addDomain()} />
              <button onclick={addDomain} disabled={domainLoading || !newDomain.trim()}
                class="px-4 py-2 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50 flex items-center gap-2">
                {#if domainLoading}<Loader2 size={14} class="animate-spin" />{/if}
                Add Domain
              </button>
            </div>
            {#if domainError}
              <p class="text-xs text-destructive flex items-center gap-1"><XCircle size={12} /> {domainError}</p>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Services -->
      {#if (project as Record<string, unknown>)?.services}
        <div class="border rounded-xl bg-card p-6 space-y-4">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <Server size={16} />
            {$t("Settings.services")}
          </h2>
          <div class="grid grid-cols-2 lg:grid-cols-3 gap-3">
            {#each ((project as Record<string, unknown>)?.services as unknown[] || []) as service}
              <div class="flex items-center justify-between p-3 rounded-lg border bg-background">
                <div class="flex items-center gap-2">
                  <Activity size={14} class={(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? 'text-green-500' : 'text-muted-foreground'} />
                  <span class="text-sm font-medium">{(service as Record<string, unknown>).name}</span>
                </div>
                <span class="text-[10px] px-2 py-0.5 rounded-full {(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground'}">
                  {(service as Record<string, unknown>).status === 'ACTIVE_HEALTHY' ? $t("Settings.active") : $t("Settings.inactive")}
                </span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- Database Info -->
      {#if (project as Record<string, unknown>)?.database}
        <div class="border rounded-xl bg-card p-6 space-y-4">
          <h2 class="text-lg font-semibold">{$t("Settings.database_info")}</h2>
          <div class="grid grid-cols-2 gap-4 text-sm">
            <div>
              <span class="text-xs text-muted-foreground">PostgreSQL</span>
              <p class="font-mono text-xs">v{((project as Record<string, unknown>)?.database as Record<string, unknown>)?.version}</p>
            </div>
            <div>
              <span class="text-xs text-muted-foreground">{$t("Dashboard.db_connections")}</span>
              <p class="font-mono text-xs">{((project as Record<string, unknown>)?.database as Record<string, unknown>)?.connection_count}</p>
            </div>
            <div>
              <span class="text-xs text-muted-foreground">{$t("Settings.db_size")}</span>
              <p class="font-mono text-xs">{(((project as Record<string, unknown>)?.database as Record<string, unknown>)?.size as number / 1024 / 1024).toFixed(1)} MB</p>
            </div>
          </div>
        </div>
      {/if}

      <!-- Project Actions -->
      <div class="border rounded-xl bg-card p-6 space-y-4">
        <h2 class="text-lg font-semibold">项目操作</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <button onclick={restartProject} disabled={!!actionInProgress}
            class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
            {#if actionInProgress === "restart"}<Loader2 size={16} class="animate-spin" />{:else}<RotateCw size={16} />{/if}
            重启项目
          </button>
          {#if (project as Record<string, unknown>)?.status === "active"}
            <button onclick={pauseProject} disabled={!!actionInProgress}
              class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg border border-amber-500 text-amber-600 hover:bg-amber-500/10 transition-colors disabled:opacity-50">
              {#if actionInProgress === "pause"}<Loader2 size={16} class="animate-spin" />{:else}<Pause size={16} />{/if}
              暂停项目
            </button>
          {:else}
            <button onclick={restoreProject} disabled={!!actionInProgress}
              class="flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold rounded-lg bg-green-600 text-white hover:bg-green-700 transition-colors disabled:opacity-50">
              {#if actionInProgress === "restore"}<Loader2 size={16} class="animate-spin" />{:else}<Activity size={16} />{/if}
              恢复项目
            </button>
          {/if}
        </div>
      </div>

      <!-- Danger Zone -->
      <div class="border border-destructive/30 rounded-xl bg-destructive/5 p-6 space-y-4">
        <div class="flex items-center gap-2">
          <AlertTriangle size={16} class="text-destructive" />
          <h2 class="text-lg font-semibold text-destructive">危险区域</h2>
        </div>
        <p class="text-xs text-muted-foreground">删除项目将永久移除所有数据、数据库、存储文件和认证用户。此操作不可撤销。</p>
        <button onclick={deleteProject} disabled={!!actionInProgress}
          class="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-destructive text-white hover:bg-destructive/90 transition-colors disabled:opacity-50">
          {#if actionInProgress === "delete"}<Loader2 size={16} class="animate-spin" />{:else}<Trash2 size={16} />{/if}
          删除项目
        </button>
      </div>
    </div>
  {/if}
</div>
