<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { createQuery } from "@tanstack/svelte-query";
  import PagePattern from "@svadmin/ui/components/PagePattern.svelte";
  import FilterToolbar from "@svadmin/ui/components/content/FilterToolbar.svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";

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
  const loadError = $derived(policiesQuery.error?.message || null);
  const pageState = $derived.by(() => {
    if (isLoading) return "loading" as const;
    if (loadError && policies.length === 0) return "error" as const;
    if (policies.length === 0) return "empty" as const;
    return "ready" as const;
  });

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

<PagePattern
  kind="list"
  pageId="storage-policies"
  title="Storage 策略"
  description="Storage schema 上的 RLS 策略管理（objects / buckets 表）"
  state={pageState}
  stateTitle={pageState === "error" ? (loadError || "加载失败") : pageState === "empty" ? "暂无 Storage RLS 策略" : "加载中..."}
  stateDescription={pageState === "empty" ? "为 storage.objects 和 storage.buckets 表创建 RLS 策略" : pageState === "error" ? loadError || undefined : undefined}
  retry={() => { void policiesQuery.refetch(); }}
  class="h-full"
>
  {#snippet toolbar()}
    <FilterToolbar bind:query={searchQuery} placeholder="搜索策略名或表名..." clearLabel="清除搜索" />
  {/snippet}

  {#if loadError && policies.length > 0}
    <div class="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs font-mono">{loadError}</div>
  {/if}
  {#if filteredPolicies.length === 0}
    <DataState state="filtered-empty" title="没有匹配结果" description="请调整或清除搜索条件。" />
  {:else}
    <div class="rounded-xl border border-border/50 bg-background shadow-sm overflow-hidden">
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
    </div>
  {/if}
</PagePattern>
