<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, Shield, Search } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createQuery } from "@tanstack/svelte-query";

  interface StoragePolicy {
    policyname: string;
    tablename: string;
    cmd: string;
    permissive: string;
    roles: string;
    qual: string;
  }

  let searchQuery = $state("");

  const projectRef = $derived(page.params.ref);

  const POLICIES_SQL = `
    SELECT
      pol.polname as policyname,
      c.relname as tablename,
      CASE pol.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' WHEN '*' THEN 'ALL' END as cmd,
      CASE pol.polpermissive WHEN true THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END as permissive,
      pg_catalog.array_to_string(ARRAY(SELECT rolname FROM pg_catalog.pg_roles WHERE oid = ANY(pol.polroles)), ', ') as roles,
      pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) as qual
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'storage'
    ORDER BY c.relname, pol.polname;
  `;

  const policiesQuery = createQuery(() => ({
    queryKey: ["storage_policies", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: POLICIES_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as StoragePolicy[];
    }
  }));

  const policies = $derived(policiesQuery.data || []);
  const isLoading = $derived(policiesQuery.isPending);

  const filteredPolicies = $derived(
    searchQuery.trim()
      ? policies.filter(p => p.policyname.toLowerCase().includes(searchQuery.toLowerCase()) || p.tablename.toLowerCase().includes(searchQuery.toLowerCase()))
      : policies
  );



  function getCmdColor(cmd: string): string {
    if (cmd === "SELECT") return "text-blue-600 bg-blue-500/10";
    if (cmd === "INSERT") return "text-green-600 bg-green-500/10";
    if (cmd === "UPDATE") return "text-amber-600 bg-amber-500/10";
    if (cmd === "DELETE") return "text-red-600 bg-red-500/10";
    return "text-violet-600 bg-violet-500/10";
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">Storage 策略</h1>
    <p class="text-sm text-muted-foreground mt-1">Storage schema 上的 RLS 策略管理（objects / buckets 表）</p>
  </div>

  <div class="relative max-w-sm">
    <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
    <input type="text" bind:value={searchQuery} placeholder="搜索策略名或表名..."
      class="w-full pl-9 pr-3 py-2 text-xs rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
  </div>

  <div class="flex-1 rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
    {#if isLoading}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
      </div>
    {:else if policies.length === 0}
      <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Shield size={40} class="opacity-20" />
        <p class="text-sm">暂无 Storage RLS 策略</p>
        <p class="text-xs">为 storage.objects 和 storage.buckets 表创建 RLS 策略</p>
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
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">条件</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20 font-mono">
            {#each filteredPolicies as policy}
              <tr class="hover:bg-muted/5 transition-colors">
                <td class="px-4 py-2.5 font-semibold text-[11px]">{policy.policyname}</td>
                <td class="px-4 py-2.5 text-[11px]">storage.{policy.tablename}</td>
                <td class="px-4 py-2.5"><span class="px-1.5 py-0.5 rounded text-[9px] font-bold {getCmdColor(policy.cmd)}">{policy.cmd}</span></td>
                <td class="px-4 py-2.5"><span class="px-1.5 py-0.5 rounded text-[9px] {policy.permissive === 'PERMISSIVE' ? 'text-green-600 bg-green-500/10' : 'text-red-600 bg-red-500/10'}">{policy.permissive}</span></td>
                <td class="px-4 py-2.5 text-[10px] text-muted-foreground truncate max-w-xs" title={policy.qual}>{policy.qual || '-'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </div>
</div>
