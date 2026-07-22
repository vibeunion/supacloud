<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { untrack } from "svelte";
  import { Loader2, Mail, Server, AlertTriangle, Save } from "lucide-svelte";
  import { createQuery, createMutation, useQueryClient } from "@tanstack/svelte-query";

  interface SmtpField {
    key: string;
    label: string;
    description: string;
    value: string;
    type: "text" | "number" | "password";
  }

  const SMTP_FIELDS: SmtpField[] = [
    { key: "SMTP_HOST", label: "SMTP Host", description: "SMTP 服务器地址", value: "", type: "text" },
    { key: "SMTP_PORT", label: "SMTP Port", description: "SMTP 服务器端口", value: "587", type: "number" },
    { key: "SMTP_USER", label: "SMTP Username", description: "SMTP 认证用户名", value: "", type: "text" },
    { key: "SMTP_PASS", label: "SMTP Password", description: "SMTP 认证密码", value: "", type: "password" },
    { key: "SMTP_ADMIN_EMAIL", label: "Sender Email", description: "发件人邮箱地址", value: "", type: "text" },
    { key: "SMTP_SENDER_NAME", label: "Sender Name", description: "发件人显示名称", value: "SupaCloud", type: "text" },
    { key: "MAILER_SECURE_EMAIL_CHANGE_ENABLED", label: "Secure Email Change", description: "变更邮箱时要求双重确认", value: "true", type: "text" },
    { key: "RATE_LIMIT_EMAIL_SENT", label: "Rate Limit (per hour)", description: "每小时最大发送量", value: "30", type: "number" },
  ];

  let fields = $state<SmtpField[]>(SMTP_FIELDS.map(f => ({ ...f })));
  let smtpEnabled = $state(false);
  let saveMsg = $state<string | null>(null);

  const projectRef = $derived(page.params.ref);
  const queryClient = useQueryClient();

  const configQuery = createQuery(() => ({
    queryKey: ["auth_config", projectRef],
    queryFn: async () => {
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`);
      if (!res.ok) throw new Error("Failed to load config");
      return await res.json();
    }
  }));

  $effect(() => {
    if (configQuery.data) {
      const config = configQuery.data;
      smtpEnabled = config.SMTP_HOST ? true : false;
      const previousFields = untrack(() => fields);
      fields = previousFields.map(f => {
        if (config[f.key] !== undefined && config[f.key] !== null) {
          return { ...f, value: String(config[f.key]) };
        }
        return f;
      });
    }
  });

  const isLoading = $derived(configQuery.isPending);

  const saveMutation = createMutation(() => ({
    mutationFn: async () => {
      const configPayload: Record<string, string> = {};
      for (const f of fields) {
        configPayload[f.key] = f.value;
      }
      if (!smtpEnabled) {
        configPayload.SMTP_HOST = "";
      }
      const res = await apiClient(`/v1/projects/${projectRef}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configPayload)
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || res.statusText);
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth_config", projectRef] });
      saveMsg = "✅ SMTP 配置已保存（GoTrue 服务已重启）";
      setTimeout(() => saveMsg = null, 4000);
    },
    onError: (err: unknown) => {
      saveMsg = `❌ 保存失败: ${(err instanceof Error ? err.message : String(err))}`;
      setTimeout(() => saveMsg = null, 4000);
    }
  }));

  async function saveConfig() {
    saveMsg = null;
    saveMutation.mutate();
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">SMTP 设置</h1>
      <p class="text-sm text-muted-foreground mt-1">配置自定义 SMTP 服务器，用于发送认证相关邮件</p>
    </div>
    <button onclick={saveConfig} disabled={saveMutation.isPending || (smtpEnabled && Object.values(fields).some(f => !f.value && f.key !== "SMTP_PASS"))}
      class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
      {#if saveMutation.isPending}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
      保存配置
    </button>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {saveMsg.startsWith('✅') ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">
      {saveMsg}
    </div>
  {/if}

  <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
    <p class="text-xs text-amber-700">启用自定义 SMTP 后，所有认证邮件（确认、重置密码、Magic Link 等）将通过你配置的 SMTP 服务器发送。保存即自动重启 GoTrue 服务。</p>
  </div>

  <div class="rounded-xl border bg-card p-5 flex items-center justify-between">
    <div class="flex items-center gap-3">
      <div class="w-9 h-9 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
        <Mail size={16} />
      </div>
      <div>
        <span class="font-semibold text-sm">启用自定义 SMTP</span>
        <p class="text-[10px] text-muted-foreground">使用自己的邮件服务器替代默认内置邮件</p>
      </div>
    </div>
    <button aria-label="Action button" onclick={() => smtpEnabled = !smtpEnabled}
      class="relative w-10 h-5 rounded-full transition-colors {smtpEnabled ? 'bg-brand' : 'bg-muted'}">
      <span class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform {smtpEnabled ? 'translate-x-5' : ''}"></span>
    </button>
  </div>

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else}
    <div class="space-y-3 {smtpEnabled ? '' : 'opacity-50 pointer-events-none'}">
      {#each fields as cfg (cfg.key)}
        <div class="rounded-xl border bg-card p-4 flex items-center justify-between">
          <div class="flex-1">
            <span class="font-medium text-sm">{cfg.label}</span>
            <p class="text-[10px] text-muted-foreground">{cfg.description}</p>
          </div>
          <div class="w-56">
            <input
              type={cfg.type}
              bind:value={cfg.value}
              placeholder={cfg.label}
              class="w-full px-3 py-1.5 text-xs font-mono rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
