<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, Save, Key, Globe, GitBranch, Terminal, Copy, RefreshCw, Trash2, Plus, ExternalLink } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);
  const deployId = $derived(page.url.pathname.split("/hosting/")[1]?.split("/")[0] || "");

  let dep: Record<string, unknown> | null = $state.raw(null);
  let isLoading = $state(true);
  let isSaving = $state(false);
  let actionMsg: string | null = $state.raw(null);

  // Editable fields
  let buildCommand = $state("");
  let outputDir = $state("");
  let installCommand = $state("");
  let nodeVersion = $state("");
  let gitUrl = $state("");
  let gitBranch = $state("");

  // Environment Variables
  let envPairs: { key: string; value: string }[] = $state.raw([]);
  let isSavingEnv = $state(false);

  // Custom Domains
  let newDomain = $state("");
  let isAddingDomain = $state(false);

  // Deploy Tokens
  let tokens: unknown[] = $state.raw([]);
  let newTokenName = $state("");
  let isCreatingToken = $state(false);
  let lastCreatedToken: string | null = $state.raw(null);

  // Build Logs
  let logs = $state("");

  async function fetchDeployment() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}`);
      if (res.ok) {
        dep = await res.json();
        if (!dep) return;
        buildCommand = String(dep.build_command || "");
        outputDir = String(dep.output_dir || "");
        installCommand = String(dep.install_command || "");
        nodeVersion = String(dep.node_version || "20");
        gitUrl = String(dep.git_url || "");
        gitBranch = String(dep.git_branch || "main");
        envPairs = Object.entries(dep.env_vars || {}).map(([key, value]) => ({ key, value: value as string }));
      }
    } catch {}

    // Fetch tokens
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/tokens`);
      if (res.ok) { const data = await res.json(); tokens = data.tokens || []; }
    } catch {}

    // Fetch logs
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/logs`);
      if (res.ok) { const data = await res.json(); logs = data.logs || ""; }
    } catch {}

    isLoading = false;
  }

  async function saveBuildConfig() {
    isSaving = true;
    try {
      await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ build_command: buildCommand, output_dir: outputDir, install_command: installCommand, node_version: nodeVersion })
      });
      // Save git config
      if (gitUrl) {
        await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/git`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ git_url: gitUrl, branch: gitBranch || "main" })
        });
      }
      actionMsg = "✅ 构建配置已保存";
    } catch (err: unknown) { actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`; }
    isSaving = false;
    setTimeout(() => actionMsg = null, 4000);
  }

  async function saveEnvVars() {
    isSavingEnv = true;
    const envObj: Record<string, string> = {};
    envPairs.filter(p => p.key.trim()).forEach(p => envObj[p.key] = p.value);
    try {
      await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env_vars: envObj })
      });
      actionMsg = "✅ 环境变量已保存";
    } catch (err: unknown) { actionMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`; }
    isSavingEnv = false;
    setTimeout(() => actionMsg = null, 4000);
  }

  async function addDomain() {
    if (!newDomain.trim()) return;
    isAddingDomain = true;
    try {
      await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: newDomain.trim() })
      });
      newDomain = "";
      await fetchDeployment();
      actionMsg = "✅ 域名已添加";
    } catch {}
    isAddingDomain = false;
    setTimeout(() => actionMsg = null, 3000);
  }

  async function removeDomain(domain: string) {
    await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/domains/${domain}`, { method: "DELETE" });
    await fetchDeployment();
  }

  async function createToken() {
    if (!newTokenName.trim()) return;
    isCreatingToken = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTokenName.trim() })
      });
      if (res.ok) {
        const data = await res.json();
        lastCreatedToken = data.token;
        newTokenName = "";
        await fetchDeployment();
      }
    } catch {}
    isCreatingToken = false;
  }

  async function deleteToken(tokenId: string) {
    await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${deployId}/tokens/${tokenId}`, { method: "DELETE" });
    await fetchDeployment();
  }

  async function copyText(text: string) { try { await navigator.clipboard.writeText(text); } catch {} }

  onMount(() => fetchDeployment());

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
        <button onclick={saveBuildConfig} disabled={isSaving} class="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
          {#if isSaving}<Loader2 size={12} class="animate-spin" />{:else}<Save size={12} />{/if} 保存
        </button>
      </div>
      <div class="p-5 grid grid-cols-2 gap-4">
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">Git URL</span><input bind:value={gitUrl} class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">分支</span><input bind:value={gitBranch} class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">构建命令</span><input bind:value={buildCommand} placeholder="npm run build" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">输出目录</span><input bind:value={outputDir} placeholder="dist" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">安装命令</span><input bind:value={installCommand} placeholder="npm install" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
        <div><span class="text-xs font-semibold text-muted-foreground block mb-1">Node 版本</span><input bind:value={nodeVersion} placeholder="20" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" /></div>
      </div>
    </div>

    <!-- Environment Variables -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
        <h3 class="text-sm font-semibold flex items-center gap-2"><Key size={16} /> 环境变量</h3>
        <div class="flex gap-2">
          <button onclick={() => envPairs = [...envPairs, { key: '', value: '' }]} class="px-2 py-1 text-[10px] rounded border hover:bg-muted/50"><Plus size={10} class="inline" /> 添加</button>
          <button onclick={saveEnvVars} disabled={isSavingEnv} class="px-3 py-1 text-[10px] font-semibold rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
            {#if isSavingEnv}<Loader2 size={10} class="animate-spin inline" />{/if} 保存
          </button>
        </div>
      </div>
      <div class="p-4 space-y-2">
        {#each envPairs as pair, i}
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
        {#each (dep.custom_domains || []) as string[] as domain}
          <div class="flex items-center justify-between py-1.5">
            <span class="text-xs font-mono">{domain}</span>
            <button onclick={() => removeDomain(domain)} class="text-red-500 text-[10px] hover:bg-red-500/10 rounded px-2 py-0.5">移除</button>
          </div>
        {/each}
        <div class="flex items-center gap-2 mt-2">
          <input bind:value={newDomain} placeholder="example.com" class="flex-1 px-3 py-1.5 text-xs font-mono rounded border bg-muted/30" />
          <button onclick={addDomain} disabled={isAddingDomain} class="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50">添加</button>
        </div>
      </div>
    </div>

    <!-- Webhook URLs -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h3 class="text-sm font-semibold">🔗 Webhook URL（设置到 Git 平台）</h3>
      </div>
      <div class="p-4 space-y-2">
        {#each [{ platform: 'GitHub', path: 'github' }, { platform: 'GitLab', path: 'gitlab' }, { platform: 'Gitee', path: 'gitee' }, { platform: 'GitCode', path: 'gitcode' }] as wh}
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
        {#each tokens as token}
          <div class="flex items-center justify-between py-1.5">
            <div><span class="text-xs font-medium">{(token as Record<string, unknown>).name}</span><span class="text-[10px] text-muted-foreground ml-2">创建于 {(token as Record<string, unknown>).created_at}</span></div>
            <button onclick={() => deleteToken(String((token as Record<string, unknown>).id))} class="text-red-500 text-[10px]">删除</button>
          </div>
        {/each}
        <div class="flex items-center gap-2 mt-2">
          <input bind:value={newTokenName} placeholder="Token 名称 (如 github-actions)" class="flex-1 px-3 py-1.5 text-xs rounded border bg-muted/30" />
          <button onclick={createToken} disabled={isCreatingToken} class="px-3 py-1.5 text-xs font-semibold rounded bg-brand text-white disabled:opacity-50">创建</button>
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
