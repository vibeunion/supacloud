<script lang="ts">
  import { apiClient } from "$lib/api";
  import { onMount } from "svelte";
  import { Key, Plus, Copy, Trash2, CheckCircle2, Clock, Shield, Bot, Globe, Lock } from "lucide-svelte";

  interface McpToken {
    token: string;
    ref: string;
    name: string;
    readonly: boolean;
    expires_days: number;
    created_at?: string;
  }

  // State
  let tokens: McpToken[] = $state([]);
  let projects: { ref: string; name: string }[] = $state([]);
  let isCreating = $state(false);
  let copiedToken = $state<string | null>(null);
  let masterToken = $state("");

  // Form
  let form = $state({
    ref: "",
    name: "default",
    readonly: true,
    expires_days: 365,
  });

  // Detect API URL from current page
  const apiBaseUrl = $derived(typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '');

  async function apiCall(url: string, method: string = "GET", body?: any): Promise<any> {
    const opts: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (body) opts.body = JSON.stringify(body);
    const res = await apiClient(url, opts);
    return await res.json();
  }

  async function loadProjects() {
    try {
      const data = await apiCall("/v1/projects");
      projects = Array.isArray(data) ? data.map((p: any) => ({ ref: p.ref, name: p.name })) : [];
    } catch { projects = []; }
  }

  async function loadMasterToken() {
    try {
      // The login endpoint returns masterToken
      const stored = typeof window !== 'undefined' ? localStorage.getItem("supacloud_token") : null;
      if (stored) {
        // Parse the stored auth to find master token
        try {
          const authData = JSON.parse(stored);
          masterToken = authData.masterToken || authData.token || "";
        } catch {
          masterToken = stored;
        }
      }
    } catch { masterToken = ""; }
  }

  async function createToken() {
    if (!form.ref) return;
    isCreating = true;
    try {
      const data = await apiCall("/mcp/tokens", "POST", {
        ref: form.ref,
        name: form.name,
        readonly: form.readonly,
        expires_days: form.expires_days,
      });
      if (data.token) {
        const project = projects.find(p => p.ref === form.ref);
        tokens = [...tokens, { ...data, name: form.name, created_at: new Date().toISOString() }];
        form.name = "default";
      }
    } catch (err: any) {
      console.error("Failed to create token:", err);
    }
    isCreating = false;
  }

  function removeToken(index: number) {
    tokens = tokens.filter((_, i) => i !== index);
  }

  function generateConfig(token: McpToken): string {
    const name = token.ref ? `supacloud-${token.ref}` : "supacloud";
    return JSON.stringify({
      mcpServers: {
        [name]: {
          url: `${apiBaseUrl}/mcp`,
          headers: { Authorization: `Bearer ${token.token}` }
        }
      }
    }, null, 2);
  }

  function generateAdminConfig(): string {
    return JSON.stringify({
      mcpServers: {
        supacloud: {
          url: `${apiBaseUrl}/mcp`,
          headers: { Authorization: `Bearer ${masterToken}` }
        }
      }
    }, null, 2);
  }

  async function copyToClipboard(text: string, id: string) {
    await navigator.clipboard.writeText(text);
    copiedToken = id;
    setTimeout(() => copiedToken = null, 2000);
  }

  onMount(() => {
    loadProjects();
    loadMasterToken();
  });
</script>

<div class="space-y-5">
  <div>
    <h2 class="text-xl font-bold flex items-center gap-2"><Bot size={22} /> MCP 配置</h2>
    <p class="text-xs text-muted-foreground mt-1">管理 MCP (Model Context Protocol) 访问令牌，让 AI Agent 安全地管理你的 SupaCloud</p>
  </div>

  <!-- Admin Config -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Shield size={16} /> 管理员配置</h3>
      <span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-600 border border-amber-500/20">完全控制</span>
    </div>
    <div class="p-4 space-y-3">
      <p class="text-xs text-muted-foreground">使用管理员 Token 可以访问全部工具（项目管理、数据库、Auth、存储等）。在 AI IDE（Claude Desktop、Cursor、Gemini）中添加以下配置：</p>
      <div class="relative group">
        <pre class="bg-muted/30 rounded-lg p-4 text-xs font-mono overflow-x-auto border">{generateAdminConfig()}</pre>
        <button
          onclick={() => copyToClipboard(generateAdminConfig(), 'admin')}
          class="absolute top-2 right-2 p-2 rounded-md bg-background/80 border opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
        >
          {#if copiedToken === 'admin'}<CheckCircle2 size={14} class="text-green-500" />{:else}<Copy size={14} />{/if}
        </button>
      </div>
    </div>
  </div>

  <!-- Create Project Token -->
  <div class="rounded-xl border bg-card overflow-hidden">
    <div class="border-b px-5 py-3 bg-muted/20">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Key size={16} /> 创建项目令牌</h3>
    </div>
    <div class="p-4 space-y-4">
      <p class="text-xs text-muted-foreground">为开发者或 AI Agent 创建受限令牌，只能访问指定项目</p>

      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <!-- Project Select -->
        <div>
          <label class="text-xs font-semibold text-muted-foreground block mb-1.5">
            <Globe size={12} class="inline" /> 项目范围 <span class="text-red-500">*</span>
          </label>
          <select
            bind:value={form.ref}
            class="w-full px-3 py-2 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          >
            <option value="">选择项目</option>
            {#each projects as project}
              <option value={project.ref}>{project.name} ({project.ref})</option>
            {/each}
          </select>
        </div>

        <!-- Token Name -->
        <div>
          <label class="text-xs font-semibold text-muted-foreground block mb-1.5">
            令牌名称
          </label>
          <input
            bind:value={form.name}
            placeholder="e.g. dev-team"
            class="w-full px-3 py-2 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>

        <!-- Permissions -->
        <div>
          <label class="text-xs font-semibold text-muted-foreground block mb-1.5">
            <Lock size={12} class="inline" /> 权限
          </label>
          <select
            bind:value={form.readonly}
            class="w-full px-3 py-2 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          >
            <option value={true}>🔒 只读（SELECT / 查看）</option>
            <option value={false}>🔓 读写（SQL 执行 / 配置修改）</option>
          </select>
        </div>

        <!-- Expiry -->
        <div>
          <label class="text-xs font-semibold text-muted-foreground block mb-1.5">
            <Clock size={12} class="inline" /> 有效期
          </label>
          <select
            bind:value={form.expires_days}
            class="w-full px-3 py-2 text-xs rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
          >
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
            <option value={90}>90 天</option>
            <option value={365}>1 年</option>
            <option value={3650}>10 年</option>
          </select>
        </div>
      </div>

      <button
        onclick={createToken}
        disabled={!form.ref || isCreating}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
      >
        <Plus size={14} />
        生成令牌
      </button>
    </div>
  </div>

  <!-- Token List -->
  {#if tokens.length > 0}
    <div class="space-y-3">
      <h3 class="text-sm font-semibold flex items-center gap-2"><Key size={16} /> 已生成的令牌 ({tokens.length})</h3>

      {#each tokens as token, index}
        {@const project = projects.find(p => p.ref === token.ref)}
        {@const config = generateConfig(token)}
        <div class="rounded-xl border bg-card overflow-hidden">
          <div class="border-b px-5 py-3 bg-muted/20 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
                <Key size={16} />
              </div>
              <div>
                <span class="text-sm font-bold">{project?.name || token.ref}</span>
                <div class="flex items-center gap-2 mt-0.5">
                  <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold {token.readonly ? 'bg-blue-500/10 text-blue-600 border border-blue-500/20' : 'bg-orange-500/10 text-orange-600 border border-orange-500/20'}">
                    {token.readonly ? '只读' : '读写'}
                  </span>
                  <span class="text-[10px] text-muted-foreground">{token.expires_days} 天有效期</span>
                </div>
              </div>
            </div>
            <button
              onclick={() => removeToken(index)}
              class="p-1.5 rounded-md text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
            >
              <Trash2 size={14} />
            </button>
          </div>
          <div class="p-4 space-y-3">
            <!-- Token Value -->
            <div>
              <label class="text-[10px] font-bold uppercase text-muted-foreground block mb-1">Token</label>
              <div class="flex items-center gap-2">
                <code class="flex-1 px-3 py-2 text-[10px] font-mono bg-muted/30 rounded-md border truncate">{token.token}</code>
                <button
                  onclick={() => copyToClipboard(token.token, `token-${index}`)}
                  class="shrink-0 p-2 rounded-md border hover:bg-muted transition-colors"
                >
                  {#if copiedToken === `token-${index}`}<CheckCircle2 size={14} class="text-green-500" />{:else}<Copy size={14} />{/if}
                </button>
              </div>
            </div>

            <!-- One-click Config Copy -->
            <div>
              <label class="text-[10px] font-bold uppercase text-muted-foreground block mb-1">MCP 配置（复制到 AI IDE）</label>
              <div class="relative group">
                <pre class="bg-muted/30 rounded-lg p-3 text-[10px] font-mono overflow-x-auto border">{config}</pre>
                <button
                  onclick={() => copyToClipboard(config, `config-${index}`)}
                  class="absolute top-2 right-2 p-2 rounded-md bg-background/80 border opacity-0 group-hover:opacity-100 transition-opacity hover:bg-muted"
                >
                  {#if copiedToken === `config-${index}`}<CheckCircle2 size={14} class="text-green-500" />{:else}<Copy size={14} />{/if}
                </button>
              </div>
            </div>
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <!-- Info -->
  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Bot size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <div class="text-xs text-blue-700">
      <b>支持的 AI IDE：</b>Claude Desktop、Cursor、Windsurf、Gemini Code Assist 等所有支持 MCP 协议的 AI 工具。
      将上方的 JSON 配置复制到 IDE 的 MCP 设置中即可使用。
    </div>
  </div>
</div>
