<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { Loader2, Shield, ArrowLeft, UserPlus, LogIn, Key } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { createQuery } from "@tanstack/svelte-query";

  const projectRef = $derived(page.params.ref);

  const authStatsQuery = createQuery(() => ({
    queryKey: ["auth-stats", projectRef],
    queryFn: async () => {
      const accessRes = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT
            has_schema_privilege(current_user, 'auth', 'USAGE') as schema_usage,
            has_table_privilege('auth.users', 'SELECT') as can_select;`
        })
      });
      const accessData = await accessRes.json();
      const access = accessData.rows?.[0];
      if (!accessRes.ok || !access?.schema_usage || !access?.can_select) {
        return { stats: null, users: [] };
      }

      // Get total user count and recent signups
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT
            count(*) as total_users,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours') as signups_24h,
            count(*) FILTER (WHERE created_at > now() - interval '7 days') as signups_7d,
            count(*) FILTER (WHERE last_sign_in_at > now() - interval '24 hours') as logins_24h,
            count(*) FILTER (WHERE last_sign_in_at > now() - interval '7 days') as logins_7d,
            count(*) FILTER (WHERE confirmed_at IS NOT NULL) as confirmed_users
          FROM auth.users;`
        })
      });
      if (!res.ok) throw new Error("Failed to fetch auth stats");
      const data = await res.json();
      const rows = data.rows || [];
      const stats = rows.length > 0 ? rows[0] : null;

      // Recent signups
      const res2 = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT id, email, created_at::text, last_sign_in_at::text,
                CASE WHEN confirmed_at IS NOT NULL THEN '已验证' ELSE '未验证' END as status
                FROM auth.users ORDER BY created_at DESC LIMIT 20;`
        })
      });
      if (!res2.ok) throw new Error("Failed to fetch recent users");
      const data2 = await res2.json();
      const users = data2.rows || [];
      
      return { stats, users };
    }
  }));

  const authStats = $derived(authStatsQuery.data?.stats || null);
  const recentUsers = $derived(authStatsQuery.data?.users || []);
  const isLoading = $derived(authStatsQuery.isPending);
</script>



<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center gap-3">
    <a href={`/project/${projectRef}/reports`} class="p-2 hover:bg-muted/50 rounded-lg transition-colors">
      <ArrowLeft size={18} />
    </a>
    <div>
      <h1 class="text-2xl font-bold">Auth 报表</h1>
      <p class="text-sm text-muted-foreground mt-1">用户注册、登录和认证事件统计</p>
    </div>
  </div>

  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    {#if authStats}
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">总用户</div>
          <div class="text-xl font-bold mt-1 text-brand">{authStats?.total_users}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">24h 注册</div>
          <div class="text-xl font-bold mt-1 text-green-600">{authStats?.signups_24h}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">7 天注册</div>
          <div class="text-xl font-bold mt-1">{authStats?.signups_7d}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">24h 登录</div>
          <div class="text-xl font-bold mt-1 text-blue-600">{authStats?.logins_24h}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">7 天登录</div>
          <div class="text-xl font-bold mt-1">{authStats?.logins_7d}</div>
        </div>
        <div class="rounded-xl border bg-card p-4">
          <div class="text-[10px] font-semibold text-muted-foreground uppercase">已验证</div>
          <div class="text-xl font-bold mt-1">{authStats?.confirmed_users}</div>
        </div>
      </div>
    {/if}

    <!-- Recent Users -->
    <div class="flex-1 rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h2 class="text-sm font-semibold flex items-center gap-2"><UserPlus size={14} /> 最近注册用户</h2>
      </div>
      {#if recentUsers.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
          <Shield size={32} class="opacity-20" />
          <p class="text-xs">暂无用户数据</p>
        </div>
      {:else}
        <div class="overflow-auto max-h-[55vh]">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b sticky top-0">
              <tr>
                <th class="px-4 py-2 font-semibold text-muted-foreground">邮箱</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">注册时间</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">最后登录</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">状态</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20 font-mono">
              {#each recentUsers as user}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2 text-[11px]">{user.email || '-'}</td>
                  <td class="px-4 py-2 text-[10px] text-muted-foreground">{String(user.created_at || "").substring(0, 19) || '-'}</td>
                  <td class="px-4 py-2 text-[10px] text-muted-foreground">{String(user.last_sign_in_at || "").substring(0, 19) || '-'}</td>
                  <td class="px-4 py-2">
                    <span class="px-1.5 py-0.5 rounded text-[9px] font-bold {user.status === '已验证' ? 'bg-green-500/10 text-green-600' : 'bg-amber-500/10 text-amber-600'}">{user.status}</span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>
