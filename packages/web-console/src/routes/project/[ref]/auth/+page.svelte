<script lang="ts">
  import { page } from "$app/state";
  import { AutoTable } from "@svadmin/ui";
  import { t } from "svelte-i18n";
  import { Mail } from "lucide-svelte";
  import { Button } from "@svadmin/ui";

  const projectRef = $derived(page.params.ref);

  function getProviders(record: Record<string, unknown>): string[] {
    const rawApp = record.raw_app_meta_data as Record<string, unknown>;
    if (rawApp?.providers && Array.isArray(rawApp.providers)) {
      return rawApp.providers;
    }
    if (rawApp?.provider) {
      return [String(rawApp.provider)];
    }
    return ["email"];
  }
</script>

<div class="flex flex-col space-y-4">
  <div class="flex items-center gap-3 mb-2">
    <h1 class="text-2xl font-bold">{$t("Navigation.auth") || "Authentication Users"}</h1>
  </div>

  <div class="flex-1 rounded-xl bg-background overflow-hidden relative min-h-[500px]">
    {#key projectRef}
      <AutoTable 
        resourceName={`v1/projects/${projectRef}/auth/users`} 
      >
        {#snippet headerActions()}
          <Button variant="outline" size="sm" class="gap-2 border-brand/20 text-brand hover:bg-brand/10">
            <Mail class="h-4 w-4" />
            {$t("Auth.invite_user") || "Invite"}
          </Button>
        {/snippet}

        {#snippet defaultCellRenderer({ field, value, record })}
          {#if field.key === 'email'}
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-full bg-brand/10 text-brand flex items-center justify-center font-bold text-xs ring-1 ring-brand/20">
                {String(value || '?').charAt(0).toUpperCase()}
              </div>
              <div class="flex flex-col">
                <span class="font-medium text-sm">{value || "-"}</span>
                <span class="text-[10px] text-muted-foreground font-mono">{record.id}</span>
              </div>
            </div>
          {:else if field.key === 'role'}
            <span class="px-2 py-0.5 bg-brand/10 text-brand text-[10px] rounded-full uppercase font-medium tracking-wider">
              {value || "user"}
            </span>
            <div class="mt-1 flex gap-1 flex-wrap">
              {#each getProviders(record) as provider}
                <span class="px-1.5 py-0.5 bg-muted rounded text-[9px] uppercase font-medium tracking-wider text-muted-foreground border border-border/50">
                  {provider}
                </span>
              {/each}
            </div>
          {:else if field.key === 'created_at' || field.key === 'last_sign_in_at'}
            <span class="text-xs text-muted-foreground tabular-nums">
              {value ? new Date(String(value)).toLocaleString() : '-'}
            </span>
          {:else}
            {value}
          {/if}
        {/snippet}
      </AutoTable>
    {/key}
  </div>
</div>
