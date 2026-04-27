<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Key, Copy, Check, Database, Code2, BookOpen, ArrowRight, Globe, Tag, Shield } from "lucide-svelte";
  import { createQuery } from "@tanstack/svelte-query";

  interface TableEndpoint {
    table_name: string;
    table_schema: string;
    columns: { name: string; type: string; nullable: boolean; default_val: string | null }[];
  }

  let copiedField = $state<string | null>(null);
  let selectedEndpoint = $state<TableEndpoint | null>(null);
  let activeTab = $state<"introduction" | "endpoints">("introduction");

  const projectRef = $derived(page.params.ref);
  const hostname = $derived(page.url?.hostname || "localhost");
  const apiUrl = $derived(`http://${hostname}:8000`);

  const projectQuery = createQuery(() => ({
    queryKey: ["v1/projects", "getOne", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}`);
      if (!res.ok) throw new Error("Failed to fetch project");
      return res.json();
    }
  }));

  const endpointsQuery = createQuery(() => ({
    queryKey: ["api-endpoints", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT t.table_name, t.table_schema,
            json_agg(json_build_object(
              'name', c.column_name,
              'type', c.data_type,
              'nullable', c.is_nullable = 'YES',
              'default_val', c.column_default
            ) ORDER BY c.ordinal_position) as columns
          FROM information_schema.tables t
          JOIN information_schema.columns c ON c.table_schema = t.table_schema AND c.table_name = t.table_name
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
          GROUP BY t.table_name, t.table_schema
          ORDER BY t.table_name`
        })
      });
      if (!res.ok) throw new Error("Failed to fetch endpoints");
      const data = await res.json();
      const rows = data.rows || [];
      return rows.map((r: Record<string, unknown>) => ({
        table_name: r.table_name,
        table_schema: r.table_schema,
        columns: typeof r.columns === 'string' ? JSON.parse(r.columns) : r.columns || []
      })) as TableEndpoint[];
    }
  }));

  const project = $derived(projectQuery.data?.data || projectQuery.data || null);
  const endpoints = $derived(endpointsQuery.data || []);
  const isLoading = $derived(projectQuery.isPending);
  const loadingEndpoints = $derived(endpointsQuery.isPending);

  async function copyToClipboard(text: string, field: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
    copiedField = field;
    setTimeout(() => copiedField = null, 2000);
  }



  function generateCurlExample(ep: TableEndpoint): string {
    return `curl '${apiUrl}/rest/v1/${ep.table_name}?select=*' \\
  -H "apikey: YOUR_ANON_KEY" \\
  -H "Authorization: Bearer YOUR_ANON_KEY"`;
  }

  function generateJsExample(ep: TableEndpoint): string {
    return `import { createClient } from '@supabase/supabase-js'

const supabase = createClient('${apiUrl}', 'YOUR_ANON_KEY')

// SELECT
const { data, error } = await supabase
  .from('${ep.table_name}')
  .select('*')

// INSERT
const { data: newRow } = await supabase
  .from('${ep.table_name}')
  .insert({ ${ep.columns.filter(c => !c.default_val?.includes('nextval')).slice(0, 2).map(c => `${c.name}: 'value'`).join(', ')} })
  .select()

// UPDATE
const { data: updated } = await supabase
  .from('${ep.table_name}')
  .update({ ${ep.columns.filter(c => !c.default_val?.includes('nextval')).slice(0, 1).map(c => `${c.name}: 'new_value'`).join('')} })
  .eq('id', 1)

// DELETE
const { error: delErr } = await supabase
  .from('${ep.table_name}')
  .delete()
  .eq('id', 1)`;
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("Navigation.api_docs")}</h1>
      <p class="text-sm text-muted-foreground mt-1">自动从数据库 Schema 生成的 REST API 文档</p>
    </div>
  </div>

  <!-- Tabs -->
  <div class="flex items-center gap-1 border-b border-border/30 pb-0">
    <button onclick={() => activeTab = "introduction"}
      class="px-4 py-2 text-xs font-medium border-b-2 transition-colors {activeTab === 'introduction' ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}">
      入门指南
    </button>
    <button onclick={() => activeTab = "endpoints"}
      class="px-4 py-2 text-xs font-medium border-b-2 transition-colors {activeTab === 'endpoints' ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}">
      API 端点 <span class="ml-1 px-1.5 py-0.5 rounded-full bg-brand/10 text-brand text-[10px]">{endpoints.length}</span>
    </button>
  </div>

  {#if isLoading}
    <div class="flex items-center justify-center py-24"><Loader2 size={32} class="animate-spin text-brand opacity-50" /></div>
  {:else if activeTab === "introduction"}
    <div class="space-y-4 max-w-3xl">
      <!-- API URL -->
      <div class="rounded-xl border bg-card p-5 space-y-3">
        <h2 class="text-sm font-semibold flex items-center gap-2"><Globe size={14} /> 项目 API URL</h2>
        <div class="flex items-center gap-2">
          <code class="flex-1 p-2.5 rounded-lg bg-muted text-xs font-mono text-brand break-all">{apiUrl}</code>
          <button onclick={() => copyToClipboard(apiUrl, 'url')} class="px-3 py-2 rounded-lg border hover:bg-muted/50 transition-colors">
            {#if copiedField === 'url'}<Check size={14} class="text-green-600" />{:else}<Copy size={14} />{/if}
          </button>
        </div>
      </div>

      <!-- Keys -->
      <div class="rounded-xl border bg-card p-5 space-y-3">
        <h2 class="text-sm font-semibold flex items-center gap-2"><Key size={14} /> API 密钥</h2>
        <div class="space-y-3">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-green-500/10 text-green-600">anon</span>
              <span class="text-[10px] text-muted-foreground">可安全用于浏览器端（需配合 RLS）</span>
            </div>
            <div class="flex items-center gap-2">
              <code class="flex-1 p-2 rounded-lg bg-muted text-[10px] font-mono break-all max-h-16 overflow-hidden">{project?.anon_key || "N/A"}</code>
              <button onclick={() => copyToClipboard(String(project?.anon_key || ''), 'anon')} class="px-2 py-1.5 rounded border hover:bg-muted/50">
                {#if copiedField === 'anon'}<Check size={12} class="text-green-600" />{:else}<Copy size={12} />{/if}
              </button>
            </div>
          </div>
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-red-500/10 text-red-600">service_role</span>
              <span class="text-[10px] text-muted-foreground">服务端专用，绕过 RLS，切勿公开</span>
            </div>
            <div class="flex items-center gap-2">
              <code class="flex-1 p-2 rounded-lg bg-muted text-[10px] font-mono break-all max-h-16 overflow-hidden" style="-webkit-text-security: disc;">{project?.service_role_key || project?.service_key || "N/A"}</code>
              <button onclick={() => copyToClipboard(String(project?.service_role_key || project?.service_key || ''), 'service')} class="px-2 py-1.5 rounded border hover:bg-muted/50">
                {#if copiedField === 'service'}<Check size={12} class="text-green-600" />{:else}<Copy size={12} />{/if}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Start -->
      <div class="rounded-xl border bg-card p-5 space-y-3">
        <h2 class="text-sm font-semibold flex items-center gap-2"><Code2 size={14} /> 快速开始</h2>
        <div class="space-y-2">
          <p class="text-xs text-muted-foreground">安装 Supabase 客户端库:</p>
          <pre class="p-3 rounded-lg bg-muted text-[11px] font-mono overflow-x-auto"><code>npm install @supabase/supabase-js</code></pre>
          <p class="text-xs text-muted-foreground">初始化客户端:</p>
          <pre class="p-3 rounded-lg bg-muted text-[11px] font-mono overflow-x-auto"><code>{`import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  '${apiUrl}',
  'YOUR_ANON_KEY'
)`}</code></pre>
        </div>
      </div>
    </div>
  {:else}
    <!-- Endpoints -->
    <div class="flex-1 flex overflow-hidden gap-4 min-h-0">
      <!-- Endpoint List -->
      <div class="w-56 border rounded-xl bg-card overflow-hidden flex flex-col shrink-0">
        <div class="px-3 py-2 border-b bg-muted/20 text-[10px] font-semibold text-muted-foreground uppercase">public 表</div>
        <div class="flex-1 overflow-y-auto p-1.5 space-y-0.5">
          {#if loadingEndpoints}
            <div class="flex items-center justify-center py-8"><Loader2 size={14} class="animate-spin text-brand opacity-50" /></div>
          {:else}
            {#each endpoints as ep}
              <button onclick={() => selectedEndpoint = ep}
                class="w-full text-left px-3 py-2 rounded-md text-xs transition-colors {selectedEndpoint?.table_name === ep.table_name ? 'bg-brand/10 text-brand font-semibold' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}">
                <Database size={10} class="inline mr-1.5 opacity-60" />{ep.table_name}
              </button>
            {/each}
          {/if}
        </div>
      </div>

      <!-- Endpoint Detail -->
      <div class="flex-1 border rounded-xl bg-card overflow-auto">
        {#if !selectedEndpoint}
          <div class="flex flex-col items-center justify-center h-full text-muted-foreground gap-3 opacity-30">
            <BookOpen size={40} />
            <p class="text-sm">选择一张表查看 API 文档</p>
          </div>
        {:else}
          <div class="p-5 space-y-5">
            <div>
              <h2 class="text-lg font-bold flex items-center gap-2"><Database size={16} /> {selectedEndpoint.table_name}</h2>
              <p class="text-xs text-muted-foreground mt-1">通过 PostgREST 自动生成的 RESTful API 端点</p>
            </div>

            <!-- HTTP Methods -->
            <div class="space-y-2">
              <h3 class="text-xs font-semibold text-muted-foreground uppercase">可用方法</h3>
              <div class="flex flex-wrap gap-2">
                {#each ["GET", "POST", "PATCH", "DELETE"] as method}
                  <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-mono">
                    <span class="font-bold {method === 'GET' ? 'text-green-600' : method === 'POST' ? 'text-blue-600' : method === 'PATCH' ? 'text-amber-600' : 'text-red-600'}">{method}</span>
                    <span class="text-muted-foreground">/rest/v1/{selectedEndpoint.table_name}</span>
                  </div>
                {/each}
              </div>
            </div>

            <!-- Columns -->
            <div class="space-y-2">
              <h3 class="text-xs font-semibold text-muted-foreground uppercase">列定义 ({selectedEndpoint.columns.length})</h3>
              <div class="overflow-x-auto">
                <table class="w-full text-xs">
                  <thead class="bg-muted/30">
                    <tr>
                      <th class="px-3 py-2 text-left font-semibold text-muted-foreground">列名</th>
                      <th class="px-3 py-2 text-left font-semibold text-muted-foreground">类型</th>
                      <th class="px-3 py-2 text-left font-semibold text-muted-foreground">可空</th>
                      <th class="px-3 py-2 text-left font-semibold text-muted-foreground">默认值</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-border/20 font-mono">
                    {#each selectedEndpoint.columns as col}
                      <tr class="hover:bg-muted/10">
                        <td class="px-3 py-1.5 font-semibold">{col.name}</td>
                        <td class="px-3 py-1.5 text-brand">{col.type}</td>
                        <td class="px-3 py-1.5">{col.nullable ? '✓' : '✗'}</td>
                        <td class="px-3 py-1.5 text-muted-foreground text-[10px] max-w-[200px] truncate">{col.default_val || '-'}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            </div>

            <!-- cURL Example -->
            <div class="space-y-2">
              <h3 class="text-xs font-semibold text-muted-foreground uppercase">cURL 示例</h3>
              <pre class="p-3 rounded-lg bg-muted text-[10px] font-mono overflow-x-auto whitespace-pre-wrap"><code>{generateCurlExample(selectedEndpoint)}</code></pre>
            </div>

            <!-- JS Example -->
            <div class="space-y-2">
              <h3 class="text-xs font-semibold text-muted-foreground uppercase">JavaScript 示例</h3>
              <pre class="p-3 rounded-lg bg-muted text-[10px] font-mono overflow-x-auto whitespace-pre-wrap"><code>{generateJsExample(selectedEndpoint)}</code></pre>
            </div>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
