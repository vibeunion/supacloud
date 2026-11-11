<script lang="ts">
  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { Loader2, Save, Send, Smartphone, AlertTriangle } from "lucide-svelte";

  type SmsConfig = {
    provider: "none" | "tencent_cloud";
    enabled: boolean;
    region: string;
    sms_sdk_app_id: string;
    sign_name: string;
    template_id: string;
    secret_id_configured: boolean;
    secret_key_configured: boolean;
    hook_configured: boolean;
  };

  const projectRef = $derived(page.params.ref ?? "");
  let config = $state<SmsConfig>({
    provider: "none",
    enabled: false,
    region: "ap-guangzhou",
    sms_sdk_app_id: "",
    sign_name: "",
    template_id: "",
    secret_id_configured: false,
    secret_key_configured: false,
    hook_configured: false,
  });
  let secretId = $state("");
  let secretKey = $state("");
  let testPhone = $state("");
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);
  let message = $state<{ success: boolean; text: string } | null>(null);

  async function loadConfig() {
    loading = true;
    try {
      const response = await apiClient(`/v1/projects/${encodeURIComponent(projectRef)}/auth/sms`);
      if (!response.ok) throw new Error("加载短信配置失败");
      config = await response.json() as SmsConfig;
    } catch (error) {
      message = { success: false, text: error instanceof Error ? error.message : "加载短信配置失败" };
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (projectRef) void loadConfig();
  });

  async function saveConfig() {
    if (saving) return;
    saving = true;
    message = null;
    try {
      const body: Record<string, string> = {
        provider: config.provider,
        region: config.region,
        sms_sdk_app_id: config.sms_sdk_app_id,
        sign_name: config.sign_name,
        template_id: config.template_id,
      };
      if (secretId.trim()) body.secret_id = secretId.trim();
      if (secretKey.trim()) body.secret_key = secretKey.trim();
      const response = await apiClient(`/v1/projects/${encodeURIComponent(projectRef)}/auth/sms`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "保存短信配置失败");
      config = result as SmsConfig;
      secretId = "";
      secretKey = "";
      message = { success: true, text: "腾讯云短信配置已保存，手机 OTP 已同步启用" };
    } catch (error) {
      message = { success: false, text: error instanceof Error ? error.message : "保存短信配置失败" };
    } finally {
      saving = false;
    }
  }

  async function sendTest() {
    if (testing || !testPhone.trim()) return;
    testing = true;
    message = null;
    try {
      const response = await apiClient(`/v1/projects/${encodeURIComponent(projectRef)}/auth/sms/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: testPhone.trim() }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.message || "测试短信发送失败");
      message = { success: true, text: "测试短信已提交，验证码为 123456" };
    } catch (error) {
      message = { success: false, text: error instanceof Error ? error.message : "测试短信发送失败" };
    } finally {
      testing = false;
    }
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold">短信 OTP</h1>
      <p class="text-sm text-muted-foreground mt-1">配置平台托管的腾讯云短信，用于手机号注册、登录和验证。</p>
    </div>
    <button onclick={saveConfig} disabled={saving || loading} class="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-50">
      {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<Save size={14} />{/if}
      保存配置
    </button>
  </div>

  {#if message}
    <div class="rounded-lg border px-4 py-2 text-xs font-medium {message.success ? 'bg-green-500/5 border-green-500/20 text-green-700' : 'bg-red-500/5 border-red-500/20 text-red-700'}">{message.text}</div>
  {/if}

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Smartphone size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">腾讯云短信模板必须包含一个验证码变量。保存后平台会自动配置 GoTrue 的 Send SMS Hook，短信密钥只会保存到项目的加密控制密钥中。</p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-24"><Loader2 size={32} class="animate-spin text-brand opacity-50" /></div>
  {:else}
    <div class="rounded-xl border bg-card p-5 space-y-5">
      <div class="flex items-center justify-between border-b pb-4">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-brand/10 text-brand flex items-center justify-center"><Smartphone size={16} /></div>
          <div>
            <span class="font-semibold text-sm">短信服务商</span>
            <p class="text-[10px] text-muted-foreground mt-0.5">中国区推荐使用腾讯云 SMS</p>
          </div>
        </div>
        <select bind:value={config.provider} class="rounded-lg border bg-background px-3 py-2 text-xs">
          <option value="none">未启用</option>
          <option value="tencent_cloud">腾讯云 SMS</option>
        </select>
      </div>

      {#if config.provider === "tencent_cloud"}
        <div class="grid gap-4 md:grid-cols-2">
          <label class="space-y-1.5"><span class="text-xs font-medium">地域</span><input bind:value={config.region} placeholder="ap-guangzhou" class="w-full rounded-md border bg-background px-3 py-2 text-sm" /></label>
          <label class="space-y-1.5"><span class="text-xs font-medium">SmsSdkAppId</span><input bind:value={config.sms_sdk_app_id} placeholder="1400xxxxxx" class="w-full rounded-md border bg-background px-3 py-2 text-sm" /></label>
          <label class="space-y-1.5"><span class="text-xs font-medium">短信签名</span><input bind:value={config.sign_name} placeholder="我的应用" class="w-full rounded-md border bg-background px-3 py-2 text-sm" /></label>
          <label class="space-y-1.5"><span class="text-xs font-medium">模板 ID</span><input bind:value={config.template_id} placeholder="1234567" class="w-full rounded-md border bg-background px-3 py-2 text-sm" /></label>
          <label class="space-y-1.5"><span class="text-xs font-medium">SecretId {#if config.secret_id_configured}<span class="text-green-600">（已配置）</span>{/if}</span><input bind:value={secretId} type="password" autocomplete="off" placeholder={config.secret_id_configured ? "留空以保留现有密钥" : "请输入 SecretId"} class="w-full rounded-md border bg-background px-3 py-2 text-sm" /></label>
          <label class="space-y-1.5"><span class="text-xs font-medium">SecretKey {#if config.secret_key_configured}<span class="text-green-600">（已配置）</span>{/if}</span><input bind:value={secretKey} type="password" autocomplete="new-password" placeholder={config.secret_key_configured ? "留空以保留现有密钥" : "请输入 SecretKey"} class="w-full rounded-md border bg-background px-3 py-2 text-sm" /></label>
        </div>

        <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
          <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
          <p class="text-xs text-amber-700">测试发送会使用验证码 123456。请确认腾讯云短信模板只有一个验证码参数，并且已完成国内短信签名和模板审核。</p>
        </div>

        <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label class="flex-1 space-y-1.5"><span class="text-xs font-medium">测试手机号（E.164）</span><input bind:value={testPhone} placeholder="+8613800138000" class="w-full rounded-md border bg-background px-3 py-2 text-sm" /></label>
          <button onclick={sendTest} disabled={testing || !config.secret_id_configured || !config.secret_key_configured} class="flex items-center justify-center gap-2 rounded-lg border border-brand/30 px-4 py-2 text-xs font-semibold text-brand hover:bg-brand/10 disabled:opacity-50">
            {#if testing}<Loader2 size={14} class="animate-spin" />{:else}<Send size={14} />{/if}
            发送测试短信
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>
