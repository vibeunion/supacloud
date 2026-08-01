<script lang="ts">
  import { apiClient, ensureMutationSucceeded } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, Save, Key, Globe, GitBranch, Terminal, Copy, RefreshCw, Trash2, Plus, ExternalLink, Upload } from "lucide-svelte";
  import { keys } from "@svadmin/core";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  const FRONTEND_DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;

  const projectRef = $derived(page.params.ref);
  const deployId = $derived(page.url.pathname.split("/hosting/")[1]?.split("/")[0] || "");

  let actionMsg: string | null = $state.raw(null);
  const queryClient = useQueryClient();

  // Editable fields (initialized when data loads)
  let buildCommand = $state("");
  let outputDir = $state("");
  let installCommand = $state("");
  let nodeVersion = $state("");
  let healthCheckPath = $state("/");
  let gitUrl = $state("");
  let gitBranch = $state("");
  let envPairs: { key: string; value: string }[] = $state([]);

  // Custom Domains
  let newDomain = $state("");
  let isAddingDomain = $state(false);

  let zipFile = $state<File | null>(null);

  let isCreatingToken = $state(false);
  let newTokenName = $state("");
  let lastCreatedToken: string | null = $state.raw(null);

  const depQuery = createQuery(() => ({
    queryKey: ["deployment", projectRef, deployId],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}`);
      if (!res.ok) return null;
      return res.json();
    }
  }));

  const tokensQuery = createQuery(() => ({
    queryKey: ["deployment_tokens", projectRef, deployId],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/tokens`);
      if (!res.ok) return [];
      const data = await res.json();
      return data.tokens || [];
    }
  }));

  const logsQuery = createQuery(() => ({
    queryKey: ["deployment_logs", projectRef, deployId],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/logs`);
      if (!res.ok) return "";
      const data = await res.json();
      return data.logs || "";
    }
  }));

  $effect(() => {
    if (depQuery.data && !buildCommand && !outputDir && !installCommand) { // Initialize editable fields once
      const d = depQuery.data;
      buildCommand = String(d.build_command || "");
      outputDir = String(d.output_dir || "");
      installCommand = String(d.install_command || "");
      nodeVersion = String(d.node_version || "20");
      healthCheckPath = String(d.health_check_path || "/");
      gitUrl = String(d.git_url || "");
      gitBranch = String(d.git_branch || "main");
      if (envPairs.length === 0) {
        envPairs = Object.entries(d.env_vars || {}).map(([key, value]) => ({ key, value: String(value) }));
      }
    }
  });

  const dep = $derived(depQuery.data);
  const isLoading = $derived(depQuery.isPending);
  const tokens = $derived(tokensQuery.data || []);
  const logs = $derived(logsQuery.data || "");

  const saveConfigMutation = createMutation(() => ({
    mutationFn: async () => {
      const updateResponse = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ build_command: buildCommand, output_dir: outputDir, install_command: installCommand, node_version: nodeVersion, health_check_path: healthCheckPath || "/" })
      });
      if (!updateResponse.ok) throw new Error("Failed to save build configuration");
      if (gitUrl) {
        const gitResponse = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/git`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ git_url: gitUrl, branch: gitBranch || "main" })
        });
        if (!gitResponse.ok) throw new Error("Failed to save Git configuration");
      }
      return true;
    },
    onSuccess: () => {
      actionMsg = "✅ 构建配置已保存";
      queryClient.invalidateQueries({ queryKey: ["deployment", projectRef, deployId] });
      setTimeout(() => actionMsg = null, 4000);
    },
    onError: (err: unknown) => {
      actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => actionMsg = null, 4000);
    }
  }));

  function saveBuildConfig() {
    saveConfigMutation.mutate();
  }

  const saveEnvMutation = createMutation(() => ({
    mutationFn: async () => {
      const envObj: Record<string, string> = {};
      envPairs.filter(p => p.key.trim()).forEach(p => envObj[p.key] = p.value);
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env_vars: envObj })
      });
      if (!res.ok) throw new Error("Failed to save environment variables");
      return true;
    },
    onSuccess: () => {
      actionMsg = "✅ 环境变量已保存";
      queryClient.invalidateQueries({ queryKey: ["deployment", projectRef, deployId] });
      setTimeout(() => actionMsg = null, 4000);
    },
    onError: (err: unknown) => {
      actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => actionMsg = null, 4000);
    }
  }));

  function saveEnvVars() {
    saveEnvMutation.mutate();
  }

  const addDomainMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim() })
      });
      if (!res.ok) throw new Error("Could not add domain");
      return true;
    },
    onSuccess: () => {
      newDomain = "";
      actionMsg = "✅ 域名已添加";
      queryClient.invalidateQueries({ queryKey: ["deployment", projectRef, deployId] });
      setTimeout(() => actionMsg = null, 3000);
    }
  }));

  function addDomain() {
    if (!newDomain.trim()) return;
    addDomainMutation.mutate();
  }

  const uploadMutation = createMutation(() => ({
    mutationFn: async (file: File) => {
      const uploadBody = new FormData();
      uploadBody.append("file", file);
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/deploy/upload`, {
        method: "POST",
        body: uploadBody,
        timeoutMs: FRONTEND_DEPLOY_TIMEOUT_MS,
      });
      const deploymentResult = await res.json();
      if (!res.ok || deploymentResult.success === false) {
        throw new Error(deploymentResult.message || deploymentResult.error || "ZIP 部署失败");
      }
      return deploymentResult;
    },
    onSuccess: () => {
      actionMsg = "✅ ZIP 部署已完成";
      zipFile = null;
      queryClient.invalidateQueries({ queryKey: ["deployment", projectRef, deployId] });
      queryClient.invalidateQueries({ queryKey: ["deployment_logs", projectRef, deployId] });
      queryClient.invalidateQueries({
        queryKey: keys()
          .resource(`v1/projects/${projectRef}/frontend/deployments`)
          .action("list")
          .get(),
      });
      setTimeout(() => actionMsg = null, 4000);
    },
    onError: (err: unknown) => {
      actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => actionMsg = null, 4000);
    },
  }));

  function selectZipFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    zipFile = input.files?.[0] || null;
  }

  function uploadZip() {
    if (zipFile) uploadMutation.mutate(zipFile);
  }

  const removeDomainMutation = createMutation(() => ({
    mutationFn: async (domain: string) => {
      const response = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/domains/${domain}`, { method: "DELETE" });
      await ensureMutationSucceeded(response, "删除域名失败");
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deployment", projectRef, deployId] });
    },
    onError: (error: unknown) => {
      actionMsg = `❌ ${error instanceof Error ? error.message : String(error)}`;
      setTimeout(() => actionMsg = null, 4000);
    }
  }));

  function removeDomain(domain: string) {
    removeDomainMutation.mutate(domain);
  }

  const createTokenMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTokenName.trim() })
      });
      if (!res.ok) throw new Error("Token create failed");
      return res.json();
    },
    onSuccess: (data) => {
      lastCreatedToken = data.token;
      newTokenName = "";
      queryClient.invalidateQueries({ queryKey: ["deployment_tokens", projectRef, deployId] });
    }
  }));

  function createToken() {
    if (!newTokenName.trim()) return;
    createTokenMutation.mutate();
  }

  const deleteTokenMutation = createMutation(() => ({
    mutationFn: async (tokenId: string) => {
      const response = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/tokens/${tokenId}`, { method: "DELETE" });
      await ensureMutationSucceeded(response, "删除访问令牌失败");
      return true;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["deployment_tokens", projectRef, deployId] });
    },
    onError: (error: unknown) => {
      actionMsg = `❌ ${error instanceof Error ? error.message : String(error)}`;
      setTimeout(() => actionMsg = null, 4000);
    }
  }));

  function deleteToken(tokenId: string) {
    deleteTokenMutation.mutate(tokenId);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error: unknown) {
      actionMsg = `❌ ${(error instanceof Error ? error.message : String(error))}`;
      setTimeout(() => actionMsg = null, 4000);
    }
  }

  const webhookBase = $derived(typeof window !== 'undefined' ? window.location.origin : '');
</script>

<div class="space-y-4 max-w-3xl">
  {#if isLoading}
    <div class="flex items-center justify-center py-24"><Loader2 size={24} class="animate-spin text-brand opacity-50" /></div>
  {:else if !dep}
    <div class="p-8 text-center text-muted-foreground">部署不存在</div>
  {:else}
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold">{dep.name}</h2>
        <p class="text-xs text-muted-foreground">{dep.framework} · ID: {dep.id}</p>
      </div>
      {#if dep.deployment_url}
        <a href={String(dep.deployment_url || "")} target="_blank" class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors"><ExternalLink size={12} /> 访问站点</a>
      {/if}
    </div>

    {#if actionMsg}
      <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">{actionMsg}</div>
    {/if}

    <!-- Build & Git Config -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
        <h3 class="text-sm font-semibold flex items-center gap-2"><GitBranch size={16} /> 构建与 Git 配置</h3>
        <button onclick={saveBuildConfig} disabled={saveConfigMutation.isPending} class="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
          {#if saveConfigMutation.isPending}<Loader2 size={12} class="animate-spin" />{:else}<Save size={12} />{/if} 保存
        </button>
      </div>
      <div class="p-5 grid grid-cols-2 gap-4">
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">Git URL</span><input bind:value={gitUrl} class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">分支</span><input bind:value={gitBranch} class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">构建命令</span><input bind:value={buildCommand} placeholder="npm run build" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">输出目录</span><input bind:value={outputDir} placeholder="dist" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">安装命令</span><input bind:value={installCommand} placeholder="npm install" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">Node 版本</span><input bind:value={nodeVersion} placeholder="20" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        {#if dep.framework === 'sveltekit'}
          <div><span class="text-xs font-semibold text-muted-foreground block mb-1">健康检查路径</span><input bind:value={healthCheckPath} placeholder="/" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        {/if}
      </div>
    </div>

    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Upload size={16} /> ZIP 部署</h3>
      </div>
      <div class="p-5 space-y-3">
        <label for="zip-upload" class="text-xs font-semibold text-muted-foreground block">上传站点 ZIP 文件</label>
        <input id="zip-upload" type="file" accept=".zip,application/zip" onchange={selectZipFile} class="block w-full text-xs file:mr-3 file:rounded-md file:border-0 file:bg-brand file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white hover:file:bg-brand/90" />
        <p class="text-[10px] text-muted-foreground">ZIP 内容会经过路径、文件数量和解压大小校验后部署。</p>
        <button onclick={uploadZip} disabled={!zipFile || uploadMutation.isPending} class="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
          {#if uploadMutation.isPending}<Loader2 size={12} class="animate-spin" />{:else}<Upload size={12} />{/if}
          {uploadMutation.isPending ? "部署中..." : "上传并部署"}
        </button>
      </div>
    </div>

    <!-- Environment Variables -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Key size={16} /> 环境变量</h3>
        <div class="flex gap-2">
          <button onclick={() => envPairs = [...envPairs, { key: '', value: '' }]} class="px-2 py-1 text-[10px] rounded border hover:bg-muted/50"><Plus size={10} class="inline" /> 添加</button>
          <button onclick={saveEnvVars} disabled={saveEnvMutation.isPending} class="px-3 py-1 text-[10px] font-semibold rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
            {#if saveEnvMutation.isPending}<Loader2 size={10} class="animate-spin inline" />{/if} 保存
          </button>
        </div>
      </div>
      <div class="p-4 space-y-2">
        {#each envPairs as pair, i (pair)}
          <div class="flex items-center gap-2">
            <input bind:value={pair.key} placeholder="KEY" class="w-40 px-2 py-1.5 text-xs font-mono rounded border bg-muted/30" />
            <span class="text-muted-foreground">=</span>
            <input bind:value={pair.value} placeholder="value" class="flex-1 px-2 py-1.5 text-xs font-mono rounded border bg-muted/30" />
            <button onclick={() => envPairs = envPairs.filter((_, idx) => idx !== i)} class="text-red-500 hover:bg-red-500/10 rounded p-1"><Trash2 size={12} /></button>
          </div>
        {/each}
        {#if envPairs.length === 0}<p class="text-center text-xs text-muted-foreground py-2">暂无环境变量</p>{/if}
      </div>
    </div>

    <!-- Custom Domains -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Globe size={16} /> 自定义域名</h3>
      </div>
      <div class="p-4">
        {#each (dep.custom_domains || []) as string[] as domain (domain)}
          <div class="flex items-center justify-between py-1.5">
            <span class="text-xs font-mono">{domain}</span>
            <button onclick={() => removeDomain(domain)} class="text-red-500 text-[10px] hover:bg-red-500/10 rounded px-2 py-0.5">移除</button>
          </div>
        {/each}
        <div class="flex items-center gap-2 mt-2">
          <input bind:value={newDomain} placeholder="example.com" class="flex-1 px-3 py-1.5 text-xs font-mono rounded border bg-muted/30" />
          <button onclick={addDomain} disabled={addDomainMutation.isPending} class="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50">添加</button>
        </div>
      </div>
    </div>

    <!-- Webhook URLs -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold">🔗 Webhook URL（设置到 Git 平台）</h3>
      </div>
      <div class="p-4 space-y-2">
        {#each [{ platform: 'GitHub', path: 'github' }, { platform: 'GitLab', path: 'gitlab' }, { platform: 'Gitee', path: 'gitee' }, { platform: 'GitCode', path: 'gitcode' }] as wh (wh.platform)}
          <div class="flex items-center justify-between">
            <div>
              <span class="text-xs font-semibold">{wh.platform}</span>
              <span class="text-[10px] font-mono text-muted-foreground ml-2">{webhookBase}/v1/webhooks/{wh.path}</span>
            </div>
            <button onclick={() => copyText(`${webhookBase}/v1/webhooks/${wh.path}`)} class="text-[10px] text-brand hover:bg-brand/10 rounded px-2 py-1"><Copy size={10} class="inline" /> 复制</button>
          </div>
        {/each}
      </div>
    </div>

    <!-- Deploy Tokens -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Key size={16} /> 部署令牌 (CI/CD)</h3>
      </div>
      <div class="p-4 space-y-2">
        {#if lastCreatedToken}
          <div class="rounded-lg bg-green-500/10 border border-green-500/20 p-3 text-xs text-green-700">
            <b>新令牌（仅显示一次）:</b>
            <code class="block mt-1 font-mono text-[10px] break-all">{lastCreatedToken}</code>
            <button onclick={() => { copyText(lastCreatedToken || ''); lastCreatedToken = null; }} class="mt-1 text-brand text-[10px] font-semibold">复制并关闭</button>
          </div>
        {/if}
        {#each tokens as token (String((token as Record<string, unknown>).id))}
          <div class="flex items-center justify-between py-1.5">
            <div><span class="text-xs font-medium">{(token as Record<string, unknown>).name}</span><span class="text-[10px] text-muted-foreground ml-2">创建于 {(token as Record<string, unknown>).created_at}</span></div>
            <button onclick={() => deleteToken(String((token as Record<string, unknown>).id))} class="text-red-500 text-[10px]">删除</button>
          </div>
        {/each}
        <div class="flex items-center gap-2 mt-2">
          <input bind:value={newTokenName} placeholder="Token 名称 (如 github-actions)" class="flex-1 px-3 py-1.5 text-xs rounded border bg-muted/30" />
          <button onclick={createToken} disabled={createTokenMutation.isPending} class="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white disabled:opacity-50">创建</button>
        </div>
      </div>
    </div>

    <!-- Build Logs -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Terminal size={16} /> 构建日志</h3>
      </div>
      <pre class="p-4 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap max-h-64 overflow-auto bg-black/5">{logs || '暂无构建日志'}</pre>
    </div>
  {/if}
</div>
