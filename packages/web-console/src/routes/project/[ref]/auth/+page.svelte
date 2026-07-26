<script lang="ts">
  import { apiClient } from "$lib/api";
  import { page } from "$app/state";
  import { AutoTable, Button } from "@svadmin/ui";
  import { t } from "svelte-i18n";
  import { Mail, UserPlus } from "lucide-svelte";
  import { createMutation } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";

  const projectRef = $derived(page.params.ref);
  let tableVersion = $state(0);
  let showInvite = $state(false);
  let showCreateUser = $state(false);
  let inviteEmail = $state("");
  let newUserEmail = $state("");
  let newUserPassword = $state("");
  let confirmEmail = $state(true);

  async function responseError(response: Response, fallback: string): Promise<string> {
    const body: unknown = await response.json().catch(() => null);
    if (body && typeof body === "object") {
      const message = (body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error;
      if (typeof message === "string" && message.trim()) return message;
    }
    return fallback;
  }

  function refreshUsers() {
    tableVersion += 1;
  }

  function closeInvite() {
    showInvite = false;
    inviteEmail = "";
  }

  function closeCreateUser() {
    showCreateUser = false;
    newUserEmail = "";
    newUserPassword = "";
    confirmEmail = true;
  }

  const inviteMutation = createMutation(() => ({
    mutationFn: async () => {
      const response = await apiClient(`/v1/projects/${projectRef}/auth/users/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim() }),
      });
      if (!response.ok) throw new Error(await responseError(response, "邀请用户失败"));
    },
    onSuccess: () => {
      closeInvite();
      refreshUsers();
      toast.success("邀请已发送");
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "邀请用户失败");
    },
  }));

  const createUserMutation = createMutation(() => ({
    mutationFn: async () => {
      const response = await apiClient(`/v1/projects/${projectRef}/auth/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: newUserEmail.trim(),
          password: newUserPassword,
          email_confirm: confirmEmail,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "新建用户失败"));
    },
    onSuccess: () => {
      closeCreateUser();
      refreshUsers();
      toast.success("用户已创建");
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : "新建用户失败");
    },
  }));

  function inviteUser() {
    if (!inviteEmail.trim()) {
      toast.error("请输入邮箱地址");
      return;
    }
    inviteMutation.mutate();
  }

  function createUser() {
    if (!newUserEmail.trim() || !newUserPassword) {
      toast.error("邮箱和密码均为必填项");
      return;
    }
    createUserMutation.mutate();
  }

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
    {#key `${projectRef}:${tableVersion}`}
      {#snippet emailRenderer({ value, record }: { value: any, record: any })}
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-full bg-brand/10 text-brand flex items-center justify-center font-bold text-xs ring-1 ring-brand/20">
            {String(value || '?').charAt(0).toUpperCase()}
          </div>
          <div class="flex flex-col">
            <span class="font-medium text-sm">{value || "-"}</span>
            <span class="text-[10px] text-muted-foreground font-mono">{record.id}</span>
          </div>
        </div>
      {/snippet}

      {#snippet roleRenderer({ value, record }: { value: any, record: any })}
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
      {/snippet}

      {#snippet dateRenderer({ value }: { value: any })}
        <span class="text-xs text-muted-foreground tabular-nums">
          {value ? new Date(String(value)).toLocaleString() : '-'}
        </span>
      {/snippet}

      <AutoTable 
        resourceName={`v1/projects/${projectRef}/auth/users`} 
        columns={{ email: emailRenderer, role: roleRenderer, created_at: dateRenderer, last_sign_in_at: dateRenderer }}
      >
        {#snippet headerActions()}
          <Button onclick={() => showCreateUser = true} size="sm" class="gap-2">
            <UserPlus class="h-4 w-4" />
            新建用户
          </Button>
          <Button onclick={() => showInvite = true} variant="outline" size="sm" class="gap-2 border-brand/20 text-brand hover:bg-brand/10">
            <Mail class="h-4 w-4" />
            {$t("Auth.invite_user") || "Invite"}
          </Button>
        {/snippet}
      </AutoTable>
    {/key}

    {#if showInvite}
      <div class="absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
        <form
          class="w-full max-w-md rounded-xl border bg-card p-5 shadow-xl space-y-4"
          onsubmit={(event) => { event.preventDefault(); inviteUser(); }}
        >
          <div>
            <h2 class="text-base font-semibold">邀请用户</h2>
            <p class="mt-1 text-xs text-muted-foreground">将向该邮箱发送注册邀请。</p>
          </div>
          <label class="block space-y-1.5">
            <span class="text-xs font-medium">邮箱</span>
            <input
              bind:value={inviteEmail}
              type="email"
              autocomplete="email"
              required
              placeholder="user@example.com"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/40"
            />
          </label>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" onclick={closeInvite}>取消</Button>
            <Button type="submit" disabled={inviteMutation.isPending}>
              {inviteMutation.isPending ? "发送中…" : "发送邀请"}
            </Button>
          </div>
        </form>
      </div>
    {/if}

    {#if showCreateUser}
      <div class="absolute inset-0 z-10 flex items-center justify-center bg-background/70 p-4 backdrop-blur-sm">
        <form
          class="w-full max-w-md rounded-xl border bg-card p-5 shadow-xl space-y-4"
          onsubmit={(event) => { event.preventDefault(); createUser(); }}
        >
          <div>
            <h2 class="text-base font-semibold">新建用户</h2>
            <p class="mt-1 text-xs text-muted-foreground">创建邮箱密码用户，可选择直接确认邮箱。</p>
          </div>
          <label class="block space-y-1.5">
            <span class="text-xs font-medium">邮箱</span>
            <input
              bind:value={newUserEmail}
              type="email"
              autocomplete="email"
              required
              placeholder="user@example.com"
              class="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/40"
            />
          </label>
          <label class="block space-y-1.5">
            <span class="text-xs font-medium">密码</span>
            <input
              bind:value={newUserPassword}
              type="password"
              autocomplete="new-password"
              required
              class="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand/40"
            />
          </label>
          <label class="flex items-center gap-2 text-xs text-muted-foreground">
            <input bind:checked={confirmEmail} type="checkbox" />
            直接确认邮箱
          </label>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" onclick={closeCreateUser}>取消</Button>
            <Button type="submit" disabled={createUserMutation.isPending}>
              {createUserMutation.isPending ? "创建中…" : "创建用户"}
            </Button>
          </div>
        </form>
      </div>
    {/if}
  </div>
</div>
