<script lang="ts">
  import { apiClient } from "$lib/api";
  import { page } from "$app/state";
  import { Loader2, Mail, Save, ChevronDown, ChevronUp, RotateCcw } from "lucide-svelte";
  import {
    parseEmailTemplateReceipt,
    parseEmailTemplates,
    type AuthEmailTemplate,
  } from "$lib/auth-settings";

  const TEMPLATE_DEF: { id: AuthEmailTemplate["id"]; name: string; description: string }[] = [
    { id: "confirmation", name: "确认邮箱", description: "用户注册后发送的邮箱确认邮件" },
    { id: "invite", name: "邀请用户", description: "管理员邀请新用户时发送的邮件" },
    { id: "magic_link", name: "Magic Link", description: "无密码登录的 Magic Link 邮件" },
    { id: "recovery", name: "密码重置", description: "用户请求重置密码时发送的邮件" },
    { id: "email_change", name: "邮箱变更", description: "用户变更邮箱地址时发送的确认邮件" },
    { id: "reauthentication", name: "重新认证", description: "敏感操作时的重新认证邮件" },
  ];

  const projectRef = $derived(page.params.ref);

  let templates = $state<AuthEmailTemplate[]>([]);
  let expandedId = $state<string | null>(null);
  let loading = $state(false);
  let loadError = $state(false);
  let busy = $state(false);
  let message = $state<{ kind: "warning" | "error"; text: string } | null>(null);

  $effect(() => {
    const ref = projectRef;
    const controller = new AbortController();
    templates = [];
    expandedId = null;
    message = null;
    loadError = false;
    loading = Boolean(ref);
    if (!ref) return () => controller.abort();
    void (async () => {
      try {
        const response = await apiClient(
          `/v1/projects/${encodeURIComponent(ref)}/auth/template`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Failed to load email templates");
        const parsed = parseEmailTemplates(await response.json());
        if (!controller.signal.aborted) templates = parsed;
      } catch {
        if (!controller.signal.aborted) loadError = true;
      } finally {
        if (!controller.signal.aborted) loading = false;
      }
    })();
    return () => controller.abort();
  });

  function snapshot(): AuthEmailTemplate[] {
    return templates.map((template) => ({ ...template }));
  }

  async function saveTemplates() {
    const ref = projectRef;
    if (!ref || busy || templates.length === 0) return;
    const expected = snapshot();
    const body = {
      templates: Object.fromEntries(expected.map((template) => [
        template.id,
        { subject: template.subject, content: template.content },
      ])),
    };
    busy = true;
    try {
      const response = await apiClient(
        `/v1/projects/${encodeURIComponent(ref)}/auth/template`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("Failed to save email templates");
      const receipt = parseEmailTemplateReceipt(payload, "save", expected);
      if (projectRef === ref && receipt.warning) message = { kind: "warning", text: receipt.warning };
    } catch (error) {
      if (projectRef === ref) {
        message = { kind: "error", text: error instanceof Error ? error.message : "保存失败" };
      }
    } finally {
      busy = false;
    }
  }

  async function resetTemplates() {
    const ref = projectRef;
    if (!ref || busy) return;
    busy = true;
    try {
      const response = await apiClient(
        `/v1/projects/${encodeURIComponent(ref)}/auth/template`,
        { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error("Failed to reset email templates");
      const receipt = parseEmailTemplateReceipt(payload, "reset");
      if (projectRef === ref) {
        if (receipt.warning) message = { kind: "warning", text: receipt.warning };
        templates = parseEmailTemplates(payload);
      }
    } catch (error) {
      if (projectRef === ref) {
        message = { kind: "error", text: error instanceof Error ? error.message : "恢复默认失败" };
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">邮件模板</h1>
      <p class="text-sm text-muted-foreground mt-1">自定义认证流程中发送给用户的邮件模板（Subject 和 Body HTML）</p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={resetTemplates}
        disabled={busy || templates.length === 0}
        class="flex items-center gap-2 px-3 py-2 text-xs font-semibold rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50"
      >
        {#if busy}<Loader2 size={14} class="animate-spin" />{:else}<RotateCcw size={14} />{/if}
        恢复默认
      </button>
      <button
        type="button"
        onclick={saveTemplates}
        disabled={busy || templates.length === 0}
        class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50"
      >
        {#if busy}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
        保存全部
      </button>
    </div>
  </div>

  {#if message}
    <div
      role={message.kind === "error" ? "alert" : "status"}
      class="rounded-lg border px-4 py-2 text-xs font-medium {message.kind === 'error' ? 'bg-red-500/5 border-red-500/20 text-red-700' : 'bg-amber-500/5 border-amber-500/20 text-amber-700'}"
    >
      {message.text}
    </div>
  {/if}

  {#if loading}
    <div class="rounded-xl border bg-card flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if loadError}
    <div role="alert" class="rounded-xl border bg-card flex items-center justify-center py-24 text-sm text-destructive">
      邮件模板暂不可用，请稍后重试。
    </div>
  {:else}
    <div class="space-y-3">
      {#each templates as template (template.id)}
        {@const def = TEMPLATE_DEF.find((item) => item.id === template.id)}
        <div class="rounded-xl border bg-card overflow-hidden">
          <button
            type="button"
            onclick={() => { expandedId = expandedId === template.id ? null : template.id; }}
            class="w-full p-5 flex items-center justify-between hover:bg-muted/10 transition-colors text-left"
          >
            <div class="flex items-center gap-3">
              <div class="w-8 h-8 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
                <Mail size={16} />
              </div>
              <div>
                <span class="font-semibold text-sm">{def?.name ?? template.id}</span>
                <p class="text-[10px] text-muted-foreground">{def?.description ?? ""}</p>
              </div>
            </div>
            <div class="flex items-center gap-2">
              {#if template.subject}
                <span class="text-[10px] font-mono text-muted-foreground max-w-[200px] truncate">{template.subject}</span>
              {/if}
              {#if expandedId === template.id}<ChevronUp size={14} class="text-muted-foreground" />{:else}<ChevronDown size={14} class="text-muted-foreground" />{/if}
            </div>
          </button>
          {#if expandedId === template.id}
            <div class="px-5 pb-5 space-y-3 border-t border-border/10 pt-3">
              <div>
                <span class="text-[10px] font-semibold text-muted-foreground uppercase">Subject</span>
                <input
                  type="text"
                  bind:value={template.subject}
                  placeholder="Email subject line"
                  class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
                />
              </div>
              <div>
                <span class="text-[10px] font-semibold text-muted-foreground uppercase">Body (HTML)</span>
                <textarea
                  bind:value={template.content}
                  rows={6}
                  placeholder="Confirm your signup - Follow this link: ConfirmationURL"
                  class="w-full mt-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand resize-y leading-5"
                  spellcheck="false"
                ></textarea>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>