<script lang="ts">
  import { apiClient } from "$lib/api";
  import { readDatabaseSqlResponse } from "$lib/database-sql-response";

  import { page } from "$app/state";
  import { Loader2, Shield, Table, Plus, Search, Trash2 } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface RlsPolicy {
    policyname: string;
    tablename: string;
    schemaname: string;
    cmd: string;
    roles: string;
    permissive: string;
    qual: string;
  }

  // Create Policy State
  let showAdd = $state(false);
  let addError = $state<string | null>(null);
  
  let newPolName = $state("");
  let newPolTable = $state("");
  let newPolAction = $state("ALL");
  let newPolRoles = $state("public");
  let newPolUsing = $state("");
  let newPolWithCheck = $state("");

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const POLICIES_SQL = `
    SELECT
      pol.polname as policyname,
      c.relname as tablename,
      n.nspname as schemaname,
      CASE pol.polcmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        WHEN '*' THEN 'ALL'
      END as cmd,
      CASE pol.polpermissive
        WHEN true THEN 'PERMISSIVE'
        ELSE 'RESTRICTIVE'
      END as permissive,
      pg_catalog.array_to_string(ARRAY(SELECT rolname FROM pg_catalog.pg_roles WHERE oid = ANY(pol.polroles)), ', ') as roles,
      pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) as qual
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname, pol.polname;
  `;

  const policiesQuery = createQuery(() => ({
    queryKey: ["auth_policies", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: POLICIES_SQL })
      });
      const data = await readDatabaseSqlResponse(res);
      return data.rows as RlsPolicy[];
    }
  }));

  const metaQuery = createQuery(() => ({
    queryKey: ["auth_policies_meta", projectRef],
    queryFn: async () => {
      const [tblRes, roleRes] = await Promise.all([
        apiClient(`/v1/projects/${projectRef}/database/sql`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename;" })
        }),
        apiClient(`/v1/projects/${projectRef}/database/sql`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sql: "SELECT rolname FROM pg_catalog.pg_roles ORDER BY rolname;" })
        })
      ]);
      const tblData = await tblRes.json();
      const roleData = await roleRes.json();
      let tables: string[] = [];
      let roles: string[] = [];
      if (!tblData.error) tables = (tblData.rows || []).map((r: Record<string, unknown>) => r.tablename as string);
      if (!roleData.error) roles = (roleData.rows || []).map((r: Record<string, unknown>) => r.rolname as string);
      return { tables, roles };
    }
  }));

  const policies = $derived(policiesQuery.data || []);
  const tables = $derived(metaQuery.data?.tables || []);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const roles = $derived(metaQuery.data?.roles || []); // Kept for reference
  const isLoading = $derived(policiesQuery.isPending);
  let searchQuery = $state("");

  const filteredPolicies = $derived(
    searchQuery.trim()
      ? policies.filter(p => p.policyname.toLowerCase().includes(searchQuery.toLowerCase()) || p.tablename.toLowerCase().includes(searchQuery.toLowerCase()))
      : policies
  );

  const saveMutation = createMutation(() => ({
    mutationFn: async () => {
      let sql = `CREATE POLICY "${newPolName}" ON public."${newPolTable}" FOR ${newPolAction} TO ${newPolRoles}`;
      if (newPolUsing) sql += ` USING (${newPolUsing})`;
      if (newPolWithCheck && (newPolAction === 'ALL' || newPolAction === 'INSERT' || newPolAction === 'UPDATE')) {
        sql += ` WITH CHECK (${newPolWithCheck})`;
      }
      sql += ";";

      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, mode: "migration" })
      });
      return readDatabaseSqlResponse(res);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["auth_policies", projectRef] });
      showAdd = false;
      newPolName = ""; newPolUsing = ""; newPolWithCheck = "";
      toast.success("RLS 策略已创建");
    },
    onError: (err: unknown) => {
      addError = (err instanceof Error ? err.message : String(err)) || "创建失败";
    }
  }));

  async function savePolicy() {
    if (!newPolName || !newPolTable) {
      addError = "策略名和表名不能为空";
      return;
    }
    addError = null;
    saveMutation.mutate();
  }

  const deleteMutation = createMutation(() => ({
    mutationFn: async (policy: RlsPolicy) => {
      const sql = `DROP POLICY "${policy.policyname}" ON "${policy.schemaname}"."${policy.tablename}";`;
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql, mode: "migration" })
      });
      return readDatabaseSqlResponse(res);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth_policies", projectRef] });
    },
    onError: (err: unknown) => {
      toast.error("删除失败: " + (err instanceof Error ? err.message : String(err)));
    }
  }));

  async function deletePolicy(policy: RlsPolicy) {
    if (!confirm(`确定要删除策略 "${policy.policyname}" 吗？\n注意：这将立即移除安全访问规则。`)) return;
    deleteMutation.mutate(policy);
  }

  function getCmdColor(cmd: string): string {
    if (cmd === "SELECT") return "text-blue-600 bg-blue-500/10";
    if (cmd === "INSERT") return "text-green-600 bg-green-500/10";
    if (cmd === "UPDATE") return "text-amber-600 bg-amber-500/10";
    if (cmd === "DELETE") return "text-red-600 bg-red-500/10";
    return "text-violet-600 bg-violet-500/10";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">RLS 策略</h1>
      <p class="text-sm text-muted-foreground mt-1">行级安全 (Row Level Security) 策略管理</p>
    </div>
    <div class="flex items-center gap-3">
      <span class="px-2.5 py-1 rounded-full bg-brand/10 text-brand text-xs font-bold">{policies.length} 条策略</span>
      <button 
        onclick={() => showAdd = !showAdd}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors"
      >
        <Plus size={14} /> 新建策略
      </button>
    </div>
  </div>

  {#if showAdd}
    <div class="rounded-xl border bg-card p-5 space-y-4">
      <h3 class="text-sm font-semibold">创建新的 RLS 策略</h3>
      {#if addError}
        <div class="p-2 bg-red-500/10 text-red-600 text-xs rounded border border-red-500/20">{addError}</div>
      {/if}
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <span class="text-xs text-muted-foreground">策略名称 (Policy Name)</span>
          <input type="text" bind:value={newPolName} placeholder="例如：允许所有人读取"
            class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
        <div>
          <span class="text-xs text-muted-foreground">目标表 (Table)</span>
          <select bind:value={newPolTable} class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand">
            <option value="" disabled>选择表...</option>
            {#each tables as tbl}
              <option value={tbl}>{tbl}</option>
            {/each}
          </select>
        </div>
        <div>
          <span class="text-xs text-muted-foreground">操作 (Action)</span>
          <select bind:value={newPolAction} class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand">
            {#each ["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"] as act}
              <option value={act}>{act}</option>
            {/each}
          </select>
        </div>
        <div>
          <span class="text-xs text-muted-foreground">目标角色 (Target Roles)</span>
          <input type="text" bind:value={newPolRoles} placeholder="如 public, authenticated 或多角色逗号分隔"
            class="w-full mt-1 px-3 py-2 text-xs rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
        
        <div class="md:col-span-2">
          <span class="text-xs text-muted-foreground">USING 表达式 (用于 SELECT/UPDATE/DELETE)</span>
          <textarea bind:value={newPolUsing} placeholder="例如：auth.uid() = user_id" rows="2"
            class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"></textarea>
        </div>
        {#if newPolAction === 'ALL' || newPolAction === 'INSERT' || newPolAction === 'UPDATE'}
        <div class="md:col-span-2">
          <span class="text-xs text-muted-foreground">WITH CHECK 表达式 (用于 INSERT/UPDATE)</span>
          <textarea bind:value={newPolWithCheck} placeholder="可选，如果不填默认与 USING 一致" rows="2"
            class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand"></textarea>
        </div>
        {/if}
      </div>
      
      <div class="flex items-center justify-end gap-3 pt-2">
        <button onclick={() => showAdd = false} class="px-4 py-2 text-xs font-medium rounded-lg hover:bg-muted/50 transition-colors">取消</button>
        <button onclick={savePolicy} disabled={saveMutation.isPending || !newPolName || !newPolTable} class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
          {#if saveMutation.isPending}<Loader2 size={12} class="animate-spin" />{/if}
          确认创建
        </button>
      </div>
    </div>
  {/if}

  <div class="relative max-w-sm">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input
      type="text"
      bind:value={searchQuery}
      placeholder="搜索策略或表名..."
      class="w-full pl-9 pr-3 py-2 text-xs rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
    />
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在查询 RLS 策略...</p>
      </div>
    {:else if policies.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Shield size={40} class="opacity-20" />
        <p class="text-sm">暂无 RLS 策略</p>
        <p class="text-xs">为表启用 RLS 并创建策略来保护数据</p>
      </div>
    {:else}
      <div class="overflow-auto max-h-[65vh]">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/30 border-b sticky top-0">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">策略名</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">表</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">操作</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">类型</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">角色</th>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">条件</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20 font-mono">
            {#each filteredPolicies as policy}
              <tr class="hover:bg-muted/5 transition-colors">
                <td class="px-4 py-2.5 font-semibold text-[11px]">
                  <div class="flex items-center gap-2">
                    <Shield size={12} class="text-brand" />
                    {policy.policyname}
                  </div>
                </td>
                <td class="px-4 py-2.5 text-[11px]">
                  <span class="text-muted-foreground">{policy.schemaname}.</span>{policy.tablename}
                </td>
                <td class="px-4 py-2.5">
                  <span class="px-1.5 py-0.5 rounded text-[9px] font-bold {getCmdColor(policy.cmd)}">{policy.cmd}</span>
                </td>
                <td class="px-4 py-2.5">
                  <span class="px-1.5 py-0.5 rounded text-[9px] {policy.permissive === 'PERMISSIVE' ? 'text-green-600 bg-green-500/10' : 'text-red-600 bg-red-500/10'}">{policy.permissive}</span>
                </td>
                <td class="px-4 py-2.5 text-[10px] text-muted-foreground">{policy.roles || 'public'}</td>
                <td class="px-4 py-2.5 text-[10px] text-muted-foreground relative group">
                  <div class="truncate max-w-[200px]" title={policy.qual}>{policy.qual || '-'}</div>
                  <div class="absolute right-4 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onclick={() => deletePolicy(policy)}
                      disabled={deleteMutation.isPending}
                      class="p-1.5 text-red-500 hover:bg-red-500/10 rounded-md transition-colors disabled:opacity-50"
                      title="删除策略"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
