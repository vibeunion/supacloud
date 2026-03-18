<script lang="ts">
  import { apiClient } from "$lib/api";

  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, Mail, FileText, Save, ChevronDown, ChevronUp } from "lucide-svelte";

  interface EmailTemplate {
    id: string;
    name: string;
    subjectKey: string;
    bodyKey: string;
    subject: string;
    body: string;
    description: string;
    expanded: boolean;
  }

  const TEMPLATES_DEF = [
    { id: "confirm", name: "确认邮箱", subjectKey: "MAILER_SUBJECTS_CONFIRMATION", bodyKey: "MAILER_TEMPLATES_CONFIRMATION_CONTENT", description: "用户注册后发送的邮箱确认邮件" },
    { id: "invite", name: "邀请用户", subjectKey: "MAILER_SUBJECTS_INVITE", bodyKey: "MAILER_TEMPLATES_INVITE_CONTENT", description: "管理员邀请新用户时发送的邮件" },
    { id: "magic_link", name: "Magic Link", subjectKey: "MAILER_SUBJECTS_MAGIC_LINK", bodyKey: "MAILER_TEMPLATES_MAGIC_LINK_CONTENT", description: "无密码登录的 Magic Link 邮件" },
    { id: "recovery", name: "密码重置", subjectKey: "MAILER_SUBJECTS_RECOVERY", bodyKey: "MAILER_TEMPLATES_RECOVERY_CONTENT", description: "用户请求重置密码时发送的邮件" },
    { id: "email_change", name: "邮箱变更", subjectKey: "MAILER_SUBJECTS_EMAIL_CHANGE", bodyKey: "MAILER_TEMPLATES_EMAIL_CHANGE_CONTENT", description: "用户变更邮箱地址时发送的确认邮件" },
    { id: "reauthentication", name: "重新认证", subjectKey: "MAILER_SUBJECTS_REAUTHENTICATION", bodyKey: "MAILER_TEMPLATES_REAUTHENTICATION_CONTENT", description: "敏感操作时的重新认证邮件" },
  ];

  let templates = $state<EmailTemplate[]>([]);
  let isLoading = $state(true);
  let saving = $state(false);
  let saveMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);

  async function fetchConfig() {
    isLoading = true;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`);
      const config = res.ok ? await res.json() : {};
      templates = TEMPLATES_DEF.map(t => ({
        ...t,
        subject: config[t.subjectKey] || "",
        body: config[t.bodyKey] || "",
        expanded: false,
      }));
    } catch {
      templates = TEMPLATES_DEF.map(t => ({ ...t, subject: "", body: "", expanded: false }));
    } finally { isLoading = false; }
  }

  async function saveTemplates() {
    saving = true;
    try {
      const payload: Record<string, string> = {};
      for (const t of templates) {
        if (t.subject) payload[t.subjectKey] = t.subject;
        if (t.body) payload[t.bodyKey] = t.body;
      }
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      saveMsg = res.ok ? "✅ 邮件模板已保存" : `❌ 保存失败`;
    } catch (err: any) {
      saveMsg = `❌ ${err.message}`;
    } finally {
      saving = false;
      setTimeout(() => saveMsg = null, 4000);
    }
  }

  onMount(() => { fetchConfig(); });
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">邮件模板</h1>
      <p class="text-sm text-muted-foreground mt-1">自定义认证流程中发送给用户的邮件模板（Subject 和 Body HTML）</p>
    </div>
    <button onclick={saveTemplates} disabled={saving}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
      {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
      保存全部
    </button>
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
      {#each templates as _, i}
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
                <textarea bind:value={tpl.body} rows={6} placeholder="Confirm your signup - Follow this link: ConfirmationURL"
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
