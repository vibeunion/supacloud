<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { ArrowLeft, UserPlus } from "lucide-svelte";
  import DataState from "@svadmin/ui/components/content/DataState.svelte";
  import MetricBlock from "@svadmin/ui/components/content/MetricBlock.svelte";
  import StatusBadge from "@svadmin/ui/components/content/StatusBadge.svelte";
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

      const res2 = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sql: `SELECT id, email, created_at::text, last_sign_in_at::text,
                confirmed_at IS NOT NULL as confirmed
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
      <h1 class="text-2xl font-bold">{$t("Reports.auth_report_title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Reports.auth_report_subtitle")}</p>
    </div>
  </div>

  {#if isLoading}
    <DataState state="loading" class="flex-1" />
  {:else}
    {#if authStats}
      <div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <MetricBlock label={$t("Reports.total_users")} value={authStats.total_users} />
        <MetricBlock label={$t("Reports.signups_24h")} value={authStats.signups_24h} />
        <MetricBlock label={$t("Reports.signups_7d")} value={authStats.signups_7d} />
        <MetricBlock label={$t("Reports.logins_24h")} value={authStats.logins_24h} />
        <MetricBlock label={$t("Reports.logins_7d")} value={authStats.logins_7d} />
        <MetricBlock label={$t("Reports.confirmed_users")} value={authStats.confirmed_users} />
      </div>
    {/if}

    <div class="flex-1 rounded-xl border bg-card overflow-hidden">
      <div class="border-b px-5 py-3 bg-muted/20">
        <h2 class="text-sm font-semibold flex items-center gap-2"><UserPlus size={14} /> {$t("Reports.recent_signups")}</h2>
      </div>
      {#if recentUsers.length === 0}
        <DataState state="empty" title={$t("Reports.no_user_data")} class="m-4" />
      {:else}
        <div class="overflow-auto max-h-[55vh]">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/30 border-b sticky top-0">
              <tr>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.email")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.signed_up_at")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.last_sign_in")}</th>
                <th class="px-4 py-2 font-semibold text-muted-foreground">{$t("Reports.status")}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20 font-mono">
              {#each recentUsers as user}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2 text-[11px]">{user.email || '-'}</td>
                  <td class="px-4 py-2 text-[10px] text-muted-foreground">{String(user.created_at || "").substring(0, 19) || '-'}</td>
                  <td class="px-4 py-2 text-[10px] text-muted-foreground">{String(user.last_sign_in_at || "").substring(0, 19) || '-'}</td>
                  <td class="px-4 py-2">
                    <StatusBadge
                      status={user.confirmed ? "success" : "warning"}
                      label={user.confirmed ? $t("Reports.confirmed") : $t("Reports.unconfirmed")}
                    />
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
