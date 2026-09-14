<script lang="ts">
  import { apiClient } from "$lib/api";
  import { runHostingMutation } from "$lib/hosting-mutations";
  import { loadHostingDetail } from "$lib/hosting-detail";
  import { createHostingToken, HostingTokenCreationError, loadHostingTokens } from "$lib/hosting-tokens";
  import { loadHostingLogs } from "$lib/hosting-logs";
  import { HostingEnvironmentConflictError, HostingEnvironmentUpdateError, saveHostingEnvironment } from "$lib/hosting-env";
  import { HostingConfigurationConflictError, saveHostingConfiguration, type HostingConfiguration } from "$lib/hosting-configuration";

  import { page } from "$app/state";
  import { Loader2, Save, Key, Globe, GitBranch, Terminal, Copy, RefreshCw, Trash2, Plus, ExternalLink, Upload } from "lucide-svelte";
  import { keys } from "@svadmin/core";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  const FRONTEND_DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;
  const TOKEN_COPY_FAILURE_MESSAGE = "复制失败，令牌仍保留在此页面。请重试。";

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
  let envRevision = $state("");
  let configurationRevision = $state("");
  let initializedDeployment: string | null = $state(null);

  // Custom Domains
  let newDomain = $state("");
  let isAddingDomain = $state(false);

  let zipFile = $state<File | null>(null);

  let isCreatingToken = $state(false);
  let newTokenName = $state("");
  type TokenScope = { projectRef: string; deploymentId: string };
  const tokenScope: TokenScope = $derived({ projectRef: projectRef ?? "", deploymentId: deployId });
  let createdToken = $state.raw<{ scope: TokenScope; token: string } | null>(null);
  const lastCreatedToken = $derived(createdToken?.scope === tokenScope ? createdToken.token : null);
  let tokenCreateInFlight = false;
  let tokenCopyInFlight = $state(false);
  let envSaveInFlight = $state(false);
  let configSaveInFlight = $state(false);

  $effect(() => {
    tokenScope;
    createdToken = null;
    newTokenName = "";
  });

  const depQuery = createQuery(() => {
    const ref = projectRef ?? "";
    const id = deployId;
    return {
      queryKey: ["deployment", ref, id],
      queryFn: ({ signal }: { signal: AbortSignal }) => loadHostingDetail(ref, id, apiClient, signal),
    };
  });

  const tokensQuery = createQuery(() => {
    const ref = projectRef ?? "";
    const id = deployId;
    return {
      queryKey: ["deployment_tokens", ref, id],
      queryFn: ({ signal }: { signal: AbortSignal }) => loadHostingTokens(ref, id, apiClient, signal),
    };
  });

  const logsQuery = createQuery(() => {
    const ref = projectRef ?? "";
    const id = deployId;
    return {
      queryKey: ["deployment_logs", ref, id],
      queryFn: ({ signal }: { signal: AbortSignal }) => loadHostingLogs(ref, id, apiClient, signal),
    };
  });

  $effect(() => {
    const d = depQuery.data;
    const scope = `${projectRef}/${deployId}`;
    if (d && d.project_ref === projectRef && d.id === deployId && initializedDeployment !== scope) {
      buildCommand = d.build_command;
      outputDir = d.output_dir;
      installCommand = d.install_command;
      nodeVersion = d.node_version;
      healthCheckPath = d.health_check_path;
      gitUrl = d.git_url ?? "";
      gitBranch = d.git_branch || "main";
      envPairs = Object.entries(d.env_vars).map(([key, value]) => ({ key, value }));
      envRevision = d.env_revision;
      configurationRevision = d.configuration_revision;
      initializedDeployment = scope;
    }
  });

  const dep = $derived(depQuery.data);
  const isLoading = $derived(depQuery.isPending);
  const tokens = $derived(tokensQuery.data || []);
  const logs = $derived(logsQuery.data || "");

  type ConfigurationSaveInput = HostingConfiguration & { scope: TokenScope; revision: string };
  const saveConfigMutation = createMutation(() => ({
    retry: false,
    mutationFn: (input: ConfigurationSaveInput) => saveHostingConfiguration(
      input.scope.projectRef, input.scope.deploymentId,
      { configuration: input.configuration, git: input.git }, apiClient, new AbortController().signal,
      input.revision,
    ),
    onSuccess: (revision, input) => {
      queryClient.invalidateQueries({ queryKey: ["deployment", input.scope.projectRef, input.scope.deploymentId] });
      if (input.scope !== tokenScope) return;
      configurationRevision = revision;
      actionMsg = "✅ 构建配置已保存";
      setTimeout(() => { if (input.scope === tokenScope) actionMsg = null; }, 4000);
    },
    onError: (error: unknown, input) => {
      queryClient.invalidateQueries({ queryKey: ["deployment", input.scope.projectRef, input.scope.deploymentId] });
      if (input.scope !== tokenScope) return;
      actionMsg = error instanceof HostingConfigurationConflictError
        ? "构建或 Git 配置已被其他操作修改。请刷新页面并重新编辑。"
        : "构建与 Git 配置可能已保存，但结果无法确认。请重新读取配置后再操作。";
    },
    onSettled: () => { configSaveInFlight = false; },
  }));

  function saveBuildConfig() {
    if (configSaveInFlight || !projectRef
      || initializedDeployment !== `${projectRef}/${deployId}`) return;
    const input: ConfigurationSaveInput = {
      scope: tokenScope,
      revision: configurationRevision,
      configuration: {
        build_command: buildCommand, output_dir: outputDir, install_command: installCommand,
        node_version: nodeVersion, health_check_path: healthCheckPath || "/",
      },
      git: { url: gitUrl, branch: gitBranch || "main" },
    };
    configSaveInFlight = true;
    saveConfigMutation.mutate(input);
  }

  const saveEnvMutation = createMutation(() => ({
    retry: false,
    mutationFn: (input: { scope: TokenScope; values: Record<string, string>; revision: string }) => saveHostingEnvironment(
      input.scope.projectRef, input.scope.deploymentId, input.values, apiClient, new AbortController().signal,
      input.revision,
    ),
    onSuccess: (revision, input) => {
      queryClient.invalidateQueries({ queryKey: ["deployment", input.scope.projectRef, input.scope.deploymentId] });
      if (input.scope !== tokenScope) return;
      envRevision = revision;
      actionMsg = "✅ 环境变量已保存";
      setTimeout(() => { if (input.scope === tokenScope) actionMsg = null; }, 4000);
    },
    onError: (error: unknown, input) => {
      queryClient.invalidateQueries({ queryKey: ["deployment", input.scope.projectRef, input.scope.deploymentId] });
      if (input.scope !== tokenScope) return;
      actionMsg = error instanceof HostingEnvironmentConflictError
        ? "环境变量已被其他操作修改。请刷新页面并重新编辑。"
        : error instanceof HostingEnvironmentUpdateError && error.mutationMayHaveApplied
        ? "环境变量可能已保存，但结果无法确认。请重新读取配置后再操作。"
        : "环境变量输入无效。";
    },
    onSettled: () => { envSaveInFlight = false; },
  }));

  function saveEnvVars() {
    if (envSaveInFlight || !projectRef
      || initializedDeployment !== `${projectRef}/${deployId}`) return;
    const values = new Map<string, string>();
    for (const pair of envPairs) {
      if (!pair.key.trim()) {
        actionMsg = "环境变量名称不能为空。";
        return;
      }
      if (values.has(pair.key)) {
        actionMsg = "环境变量名称重复。";
        return;
      }
      values.set(pair.key, pair.value);
    }
    envSaveInFlight = true;
    saveEnvMutation.mutate({ scope: tokenScope, values: Object.fromEntries(values), revision: envRevision });
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
        queryKey: keys().data.list(`v1/projects/${projectRef}/frontend/deployments`),
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
      await runHostingMutation(projectRef, deployId, { operation: "remove_domain", domain });
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
    retry: false,
    mutationFn: async (input: { scope: TokenScope; name: string }): Promise<void> => {
      const data = await createHostingToken(
        input.scope.projectRef, input.scope.deploymentId, input.name, apiClient, new AbortController().signal,
      );
      if (input.scope === tokenScope) createdToken = { scope: input.scope, token: data.token };
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["deployment_tokens", input.scope.projectRef, input.scope.deploymentId] });
      if (input.scope !== tokenScope) return;
      newTokenName = "";
    },
    onError: (error: unknown, input) => {
      if (error instanceof HostingTokenCreationError && error.mutationMayHaveApplied) {
        queryClient.invalidateQueries({ queryKey: ["deployment_tokens", input.scope.projectRef, input.scope.deploymentId] });
      }
      if (input.scope !== tokenScope) return;
      actionMsg = error instanceof HostingTokenCreationError && error.mutationMayHaveApplied
        ? "令牌可能已创建，但结果无法确认。请检查令牌列表后再操作。"
        : "无法创建令牌，请检查输入。";
    },
    onSettled: () => { tokenCreateInFlight = false; },
  }));

  function createToken() {
    if (!newTokenName.trim() || tokenCreateInFlight) return;
    tokenCreateInFlight = true;
    createdToken = null;
    createTokenMutation.mutate({ scope: tokenScope, name: newTokenName.trim() });
  }

  const deleteTokenMutation = createMutation(() => ({
    mutationFn: async (tokenId: string) => {
      await runHostingMutation(projectRef, deployId, { operation: "delete_token", tokenId });
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

  async function copyCreatedToken() {
    const captured = createdToken;
    if (!captured || captured.scope !== tokenScope || tokenCopyInFlight) return;
    tokenCopyInFlight = true;
    try {
      await navigator.clipboard.writeText(captured.token);
      if (createdToken === captured && captured.scope === tokenScope) {
        createdToken = null;
        if (actionMsg === TOKEN_COPY_FAILURE_MESSAGE) actionMsg = null;
      }
    } catch {
      if (createdToken === captured && captured.scope === tokenScope) {
        actionMsg = TOKEN_COPY_FAILURE_MESSAGE;
      }
    } finally {
      tokenCopyInFlight = false;
    }
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
  {:else if depQuery.isError}
    <div class="p-8 text-center text-red-600">无法读取部署详情</div>
  {:else if !dep}
    <div class="p-8 text-center text-muted-foreground">部署不存在</div>
  {:else}
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-xl font-bold">{dep.name}</h2>
        <p class="text-xs text-muted-foreground">{dep.framework} · ID: {dep.id}</p>
      </div>
      {#if dep.deployment_url}
        <a href={dep.deployment_url} target="_blank" rel="noopener noreferrer" class="flex items-center gap-2 px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors"><ExternalLink size={12} /> 访问站点</a>
      {/if}
    </div>

    {#if actionMsg}
      <div class="rounded-lg border px-4 py-3 text-xs font-medium {actionMsg.startsWith('✅') ? 'bg-green-500/10 border-green-500/20 text-green-700' : 'bg-red-500/10 border-red-500/20 text-red-700'}">{actionMsg}</div>
    {/if}

    <!-- Build & Git Config -->
    <div class="rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
        <h3 class="text-sm font-semibold flex items-center gap-2"><GitBranch size={16} /> 构建与 Git 配置</h3>
        <button onclick={saveBuildConfig} disabled={configSaveInFlight} class="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-md bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
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
          <button onclick={saveEnvVars} disabled={envSaveInFlight} class="px-3 py-1 text-[10px] font-semibold rounded bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
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
        {#each dep.custom_domains as domain (domain)}
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
            <button onclick={copyCreatedToken} disabled={tokenCopyInFlight} class="mt-1 text-brand text-[10px] font-semibold disabled:opacity-50"><Copy size={10} class="inline" /> 复制并关闭</button>
          </div>
        {/if}
        {#if tokensQuery.isPending}
          <div class="py-2"><Loader2 size={16} class="animate-spin" /></div>
        {:else if tokensQuery.isError}
          <p class="text-xs text-red-600">无法读取部署令牌</p>
        {:else}
          {#each tokens as token (token.id)}
            <div class="flex items-center justify-between py-1.5">
              <div><span class="text-xs font-medium">{token.name}</span><span class="text-[10px] text-muted-foreground ml-2">创建于 {token.created_at}</span></div>
              <button onclick={() => deleteToken(token.id)} class="text-red-500 text-[10px]">删除</button>
            </div>
          {/each}
        {/if}
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
      {#if logsQuery.isPending}
        <div class="p-4"><Loader2 size={16} class="animate-spin" /></div>
      {:else if logsQuery.isError}
        <p class="p-4 text-xs text-red-600">无法读取构建日志</p>
      {:else}
        <pre class="p-4 text-[10px] font-mono text-muted-foreground whitespace-pre-wrap max-h-64 overflow-auto bg-black/5">{logs || '暂无构建日志'}</pre>
      {/if}
    </div>
  {/if}
</div>
