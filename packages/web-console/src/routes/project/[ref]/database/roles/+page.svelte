<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { t } from "svelte-i18n";
  import { Loader2, Shield, ShieldCheck, User, Plus, Trash2, X, Save } from "lucide-svelte";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";

  interface Role {
    rolname: string;
    rolsuper: boolean;
    rolcanlogin: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
    rolreplication: boolean;
    rolconnlimit: number;
    active_connections: number;
    member_of: string;
  }

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const SUPABASE_ROLES = [
    "postgres", "supabase_admin", "supabase_auth_admin", "supabase_storage_admin",
    "supabase_functions_admin", "supabase_read_only_user", "supabase_replication_admin",
    "authenticator", "anon", "authenticated", "service_role", "dashboard_user",
    "pgbouncer", "pgsodium_keyholder", "pgsodium_keyiduser", "pgsodium_keymaker"
  ];

  const ROLE_DESCRIPTION_KEYS: Record<string, string> = {
    anon: "Roles.role_anon",
    authenticated: "Roles.role_authenticated",
    authenticator: "Roles.role_authenticator",
    dashboard_user: "Roles.role_dashboard_user",
    postgres: "Roles.role_postgres",
    service_role: "Roles.role_service_role",
    supabase_read_only_user: "Roles.role_read_only",
  };

  const ROLES_SQL = `
    SELECT 
      r.rolname,
      r.rolsuper,
      r.rolcanlogin,
      r.rolcreatedb,
      r.rolcreaterole,
      r.rolreplication,
      r.rolconnlimit,
      COALESCE(s.numbackends, 0)::int as active_connections,
      COALESCE(string_agg(am.rolname, ', '), '') as member_of
    FROM pg_roles r
    LEFT JOIN pg_stat_database s ON s.datname = current_database() AND EXISTS (
      SELECT 1 FROM pg_stat_activity sa WHERE sa.usename = r.rolname AND sa.datname = current_database()
    )
    LEFT JOIN pg_auth_members m ON m.member = r.oid
    LEFT JOIN pg_roles am ON am.oid = m.roleid
    WHERE r.rolname NOT LIKE 'pg_%'
    GROUP BY r.rolname, r.rolsuper, r.rolcanlogin, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolconnlimit, s.numbackends
    ORDER BY r.rolname;
  `;

  const rolesQuery = createQuery(() => ({
    queryKey: ["database_roles", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: ROLES_SQL })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.message || data.error);
      return (data.rows || []) as Role[];
    }
  }));

  const roles = $derived((rolesQuery.data as Role[]) || []);
  const isLoading = $derived(rolesQuery.isPending);
  const error = $derived(rolesQuery.error?.message || null);

  let showCreateRole = $state(false);
  let newRoleName = $state("");
  let newRoleLogin = $state(true);
  let newRoleSuper = $state(false);
  let newRoleCreateDb = $state(false);
  let newRolePassword = $state("");
  let isCreating = $state(false);
  let roleMsg = $state<string | null>(null);

  async function createRole() {
    if (!newRoleName.trim()) { roleMsg = `❌ ${$t("Roles.name_required")}`; setTimeout(() => roleMsg = null, 3000); return; }
    isCreating = true;
    const opts = [];
    if (newRoleLogin) opts.push("LOGIN");
    if (newRoleSuper) opts.push("SUPERUSER");
    if (newRoleCreateDb) opts.push("CREATEDB");
    if (newRolePassword) opts.push(`PASSWORD '${newRolePassword.replace(/'/g, "''")}'`);
    const sql = `CREATE ROLE "${newRoleName.trim()}" ${opts.join(' ')};`;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql })
      });
      const data = await res.json();
      if (data.error) { roleMsg = `❌ ${data.message || data.error}`; }
      else { 
        roleMsg = `✅ ${$t("Roles.created", { values: { name: newRoleName } })}`;
        showCreateRole = false; newRoleName = ""; newRolePassword = ""; 
        queryClient.invalidateQueries({ queryKey: ["database_roles", projectRef] }); 
      }
    } catch (err: unknown) { roleMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`; }
    finally { isCreating = false; setTimeout(() => roleMsg = null, 4000); }
  }

  async function deleteRole(rolename: string) {
    if (!confirm($t("Roles.delete_confirmation", { values: { name: rolename } }))) return;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/database/sql`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: `DROP ROLE IF EXISTS "${rolename}";` })
      });
      const data = await res.json();
      if (data.error) { roleMsg = `❌ ${data.message || data.error}`; }
      else { 
        roleMsg = $t("Roles.deleted", { values: { name: rolename } });
        queryClient.invalidateQueries({ queryKey: ["database_roles", projectRef] }); 
      }
    } catch (err: unknown) { roleMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`; }
    finally { setTimeout(() => roleMsg = null, 4000); }
  }


  const supabaseRoles = $derived(roles.filter(r => SUPABASE_ROLES.includes(r.rolname)));
  const customRoles = $derived(roles.filter(r => !SUPABASE_ROLES.includes(r.rolname)));

  function roleDescription(roleName: string): string {
    const descriptionKey = ROLE_DESCRIPTION_KEYS[roleName];
    return descriptionKey ? $t(descriptionKey) : $t("Roles.role_managed_generic");
  }
</script>

<div class="h-full flex flex-col space-y-6">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">{$t("Roles.title")}</h1>
      <p class="text-sm text-muted-foreground mt-1">{$t("Roles.subtitle")}</p>
    </div>
    <button onclick={() => showCreateRole = !showCreateRole}
      class="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors">
      <Plus size={14} /> {$t("Roles.create_role")}
    </button>
  </div>

  {#if roleMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {roleMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : roleMsg.startsWith('❌') ? 'bg-red-500/5 border-red-500/20 text-red-700' : 'bg-muted text-muted-foreground'}">{roleMsg}</div>
  {/if}

  {#if showCreateRole}
    <div class="rounded-xl border bg-brand/5 border-brand/20 p-4 space-y-3">
      <div class="flex items-center justify-between">
        <span class="text-sm font-semibold text-brand">{$t("Roles.create_new")}</span>
        <button onclick={() => showCreateRole = false} class="text-muted-foreground hover:text-foreground"><X size={14} /></button>
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div>
          <span class="text-[10px] font-semibold text-muted-foreground uppercase">{$t("Roles.name")} *</span>
          <input type="text" bind:value={newRoleName} placeholder="my_role"
            class="w-full mt-1 px-3 py-1.5 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
        <div>
          <span class="text-[10px] font-semibold text-muted-foreground uppercase">{$t("Roles.password_optional")}</span>
          <input type="password" bind:value={newRolePassword} placeholder={$t("Roles.optional")}
            class="w-full mt-1 px-3 py-1.5 text-xs font-mono rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
        <div class="flex flex-col gap-2 justify-end">
          <label class="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" bind:checked={newRoleLogin} class="rounded" /> {$t("Roles.allow_login")} (LOGIN)
          </label>
          <label class="flex items-center gap-2 text-xs cursor-pointer">
            <input type="checkbox" bind:checked={newRoleCreateDb} class="rounded" /> {$t("Roles.create_database")} (CREATEDB)
          </label>
        </div>
        <div class="flex items-end">
          <button onclick={createRole} disabled={isCreating}
            class="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 disabled:opacity-50">
            {#if isCreating}<Loader2 size={12} class="animate-spin" />{:else}<Save size={12} />{/if} {$t("Roles.create")}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if isLoading}
    <div class="flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
      <p class="text-xs font-mono uppercase tracking-widest">{$t("Roles.loading")}</p>
    </div>
  {:else if error}
    <div class="p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm font-mono">{error}</div>
  {:else}
    <div>
      <div class="flex items-center gap-2 px-4 py-2.5 bg-muted/30 border rounded-t-lg">
        <ShieldCheck size={14} class="text-green-500" />
        <div>
          <span class="text-sm font-medium text-muted-foreground">{$t("Roles.supabase_managed")}</span>
          <p class="text-[10px] text-muted-foreground">{$t("Roles.managed_description")}</p>
        </div>
        <span class="px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 text-[10px] font-bold">{$t("Roles.protected")}</span>
      </div>
      <div class="border border-t-0 rounded-b-lg overflow-hidden">
        <table class="w-full text-left text-xs">
          <thead class="bg-muted/20 border-b">
            <tr>
              <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Roles.name")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.superuser")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.can_login")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.can_create_db")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.replication")}</th>
              <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.connections")}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border/20">
            {#each supabaseRoles as role}
              <tr class="hover:bg-muted/10 transition-colors">
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <Shield size={13} class="text-muted-foreground/50" />
                    <div>
                      <span class="font-mono font-medium">{role.rolname}</span>
                      <p class="mt-0.5 text-[10px] text-muted-foreground">{roleDescription(role.rolname)}</p>
                    </div>
                  </div>
                </td>
                <td class="px-3 py-2.5 text-center">
                  <span class={role.rolsuper ? "text-green-500 font-bold" : "text-muted-foreground/40"}>{role.rolsuper ? "✓" : "—"}</span>
                </td>
                <td class="px-3 py-2.5 text-center">
                  <span class={role.rolcanlogin ? "text-green-500 font-bold" : "text-muted-foreground/40"}>{role.rolcanlogin ? "✓" : "—"}</span>
                </td>
                <td class="px-3 py-2.5 text-center">
                  <span class={role.rolcreatedb ? "text-green-500 font-bold" : "text-muted-foreground/40"}>{role.rolcreatedb ? "✓" : "—"}</span>
                </td>
                <td class="px-3 py-2.5 text-center">
                  <span class={role.rolreplication ? "text-green-500 font-bold" : "text-muted-foreground/40"}>{role.rolreplication ? "✓" : "—"}</span>
                </td>
                <td class="px-3 py-2.5 text-center">
                  <span class="font-mono tabular-nums">{role.rolconnlimit === -1 ? "∞" : role.rolconnlimit}</span>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>

    {#if customRoles.length > 0}
      <div>
        <div class="flex items-center gap-2 px-4 py-2.5 bg-muted/30 border rounded-t-lg">
          <User size={14} class="text-muted-foreground" />
          <span class="text-sm font-medium text-muted-foreground">{$t("Roles.custom_roles")}</span>
          <span class="px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground text-[10px] font-bold">{customRoles.length}</span>
        </div>
        <div class="border border-t-0 rounded-b-lg overflow-hidden">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/20 border-b">
              <tr>
                <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Roles.name")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.superuser")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.can_login")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.can_create_db")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.replication")}</th>
                <th class="px-3 py-2.5 font-semibold text-muted-foreground text-center">{$t("Roles.connections")}</th>
                <th class="px-4 py-2.5 font-semibold text-muted-foreground">{$t("Roles.member_of")}</th>
                <th class="px-2 py-2.5 font-semibold text-muted-foreground text-center w-10"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border/20">
              {#each customRoles as role}
                <tr class="hover:bg-muted/10 transition-colors">
                  <td class="px-4 py-2.5">
                    <div class="flex items-center gap-2">
                      <User size={13} class="text-brand/60" />
                      <span class="font-mono font-medium">{role.rolname}</span>
                    </div>
                  </td>
                  <td class="px-3 py-2.5 text-center">
                    <span class={role.rolsuper ? "text-green-500 font-bold" : "text-muted-foreground/40"}>{role.rolsuper ? "✓" : "—"}</span>
                  </td>
                  <td class="px-3 py-2.5 text-center">
                    <span class={role.rolcanlogin ? "text-green-500 font-bold" : "text-muted-foreground/40"}>{role.rolcanlogin ? "✓" : "—"}</span>
                  </td>
                  <td class="px-3 py-2.5 text-center">
                    <span class={role.rolcreatedb ? "text-green-500 font-bold" : "text-muted-foreground/40"}>{role.rolcreatedb ? "✓" : "—"}</span>
                  </td>
                  <td class="px-3 py-2.5 text-center">
                    <span class={role.rolreplication ? "text-green-500 font-bold" : "text-muted-foreground/40"}>{role.rolreplication ? "✓" : "—"}</span>
                  </td>
                  <td class="px-3 py-2.5 text-center">
                    <span class="font-mono tabular-nums">{role.rolconnlimit === -1 ? "∞" : role.rolconnlimit}</span>
                  </td>
                  <td class="px-4 py-2.5 text-muted-foreground">{role.member_of || "—"}</td>
                  <td class="px-2 py-2.5 text-center">
                    <button onclick={() => deleteRole(role.rolname)}
                      class="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      title={$t("Roles.delete_action")}>
                      <Trash2 size={12} />
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/if}
</div>
