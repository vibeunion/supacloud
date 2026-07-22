<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { untrack } from "svelte";
  import { Loader2, Mail, Save, ChevronDown, ChevronUp, RotateCcw } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface EmailTemplate {
    id: string;
    name: string;
    subject: string;
    content: string;
    description: string;
    expanded: boolean;
  }

  const TEMPLATES_DEF = [
    { id: "confirmation", name: "确认邮箱", description: "用户注册后发送的邮箱确认邮件" },
    { id: "invite", name: "邀请用户", description: "管理员邀请新用户时发送的邮件" },
    { id: "magic_link", name: "Magic Link", description: "无密码登录的 Magic Link 邮件" },
    { id: "recovery", name: "密码重置", description: "用户请求重置密码时发送的邮件" },
    { id: "email_change", name: "邮箱变更", description: "用户变更邮箱地址时发送的确认邮件" },
    { id: "reauthentication", name: "重新认证", description: "敏感操作时的重新认证邮件" },
  ];

  let saveMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const configQuery = createQuery(() => ({
    queryKey: ["auth_templates", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/template`);
      if (!res.ok) throw new Error("Failed to load email templates");
      return await res.json();
    }
  }));

  let templates = $state<EmailTemplate[]>(TEMPLATES_DEF.map(t => ({ ...t, subject: "", content: "", expanded: false })));

  $effect(() => {
    if (configQuery.data) {
      const config = configQuery.data.templates || {};
      const previousTemplates = untrack(() => templates);
      // Preserve expanded state when refreshing
      templates = previousTemplates.map(t => ({
        ...t,
        subject: config[t.id]?.subject || "",
        content: config[t.id]?.content || "",
      }));
    }
  });

  const isLoading = $derived(configQuery.isPending);

  const saveMutation = createMutation(() => ({
    mutationFn: async () => {
      const payload: Record<string, { subject: string; content: string }> = {};
      for (const t of templates) {
        payload[t.id] = { subject: t.subject, content: t.content };
      }
      const res = await apiClient(`/v1/projects/${projectRef}/auth/template`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templates: payload })
      });
      if (!res.ok) throw new Error("保存失败");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth_templates", projectRef] });
      saveMsg = "✅ 邮件模板已保存（GoTrue 已重启）";
      setTimeout(() => saveMsg = null, 4000);
    },
    onError: (err: unknown) => {
      saveMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => saveMsg = null, 4000);
    }
  }));

  const resetMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/template`, {
        method: "DELETE"
      });
      if (!res.ok) throw new Error("恢复默认失败");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth_templates", projectRef] });
      saveMsg = "✅ 邮件模板已恢复默认（GoTrue 已重启）";
      setTimeout(() => saveMsg = null, 4000);
    },
    onError: (err: unknown) => {
      saveMsg = `❌ ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => saveMsg = null, 4000);
    }
  }));

  async function saveTemplates() {
    saveMsg = null;
    saveMutation.mutate();
  }

  async function resetTemplates() {
    saveMsg = null;
    resetMutation.mutate();
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">邮件模板</h1>
      <p class="text-sm text-muted-foreground mt-1">自定义认证流程中发送给用户的邮件模板（Subject 和 Body HTML）</p>
    </div>
    <div class="flex items-center gap-2">
      <button onclick={resetTemplates} disabled={resetMutation.isPending || saveMutation.isPending}
        class="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50">
        {#if resetMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<RotateCcw size={14} />{/if}
        恢复默认
      </button>
      <button onclick={saveTemplates} disabled={saveMutation.isPending || resetMutation.isPending}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
        {#if saveMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
        保存全部
      </button>
    </div>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {saveMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">{saveMsg}</div>
  {/if}

  {#if isLoading}
    <div class="rounded-xl border bg-card flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <div class="space-y-3">
      {#each templates as _, i (templates[i].id)}
        {@const tpl = templates[i]}
        <div class="rounded-xl border bg-card overflow-hidden">
          <button onclick={() => templates[i].expanded = !templates[i].expanded}
            class="w-full p-5 flex items-center justify-between hover:bg-muted/10 transition-colors text-left">
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
                <Mail size={16} />
              </div>
              <div>
                <span class="font-semibold text-sm">{tpl.name}</span>
                <p class="text-[10px] text-muted-foreground">{tpl.description}</p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              {#if tpl.subject}
                <span class="text-[10px] font-mono text-muted-foreground max-w-[200px] truncate">{tpl.subject}</span>
              {/if}
              {#if tpl.expanded}<ChevronUp size={14} class="text-muted-foreground" />{:else}<ChevronDown size={14} class="text-muted-foreground" />{/if}
            </div>
          </button>
          {#if tpl.expanded}
            <div class="px-5 pb-5 space-y-3 border-t border-border/10 pt-3">
              <div>
                <span class="text-[10px] font-semibold text-muted-foreground uppercase">Subject</span>
                <input type="text" bind:value={tpl.subject} placeholder="Email subject line"
                  class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
              </div>
              <div>
                <span class="text-[10px] font-semibold text-muted-foreground uppercase">Body (HTML)</span>
                <textarea bind:value={tpl.content} rows={6} placeholder="Confirm your signup - Follow this link: ConfirmationURL"
                  class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand resize-y leading-5"
                  spellcheck="false"></textarea>
                <p class="text-[9px] text-muted-foreground mt-1">可用变量: .ConfirmationURL, .Token, .SiteURL, .Email（用双花括号包裹）</p>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>
