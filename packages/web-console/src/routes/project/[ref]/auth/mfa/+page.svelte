<script lang="ts">
  import { page } from "$app/state";
  import { Shield, Smartphone, Key, AlertTriangle, Clock } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  interface MfaConfig {
    name: string;
    description: string;
    icon: typeof Shield;
    enabled: boolean;
    detail: string;
  }

  let configs = $state<MfaConfig[]>([
    { name: "TOTP (Authenticator App)", description: "基于时间的一次性密码，使用 Google Authenticator、Authy 等应用", icon: Smartphone, enabled: true, detail: "推荐使用，安全性高" },
    { name: "Phone (SMS)", description: "通过短信发送验证码进行二次验证", icon: Smartphone, enabled: false, detail: "需要配置 SMS 提供商" },
    { name: "WebAuthn", description: "使用硬件安全密钥或设备生物识别（指纹/面部识别）", icon: Key, enabled: false, detail: "需要浏览器支持 WebAuthn API" },
  ]);

  let enforcementLevel = $state<"optional" | "required">("optional");
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">多因素认证 (MFA)</h1>
    <p class="text-sm text-muted-foreground mt-1">为用户账户添加额外的安全层</p>
  </div>

  <!-- Enforcement Level -->
  <div class="rounded-xl border bg-card p-5 space-y-3">
    <h3 class="text-sm font-semibold flex items-center gap-2"><Shield size={14} /> MFA 强制级别</h3>
    <div class="flex gap-3">
      <button
        onclick={() => enforcementLevel = "optional"}
        class="flex-1 p-3 rounded-lg border text-left transition-colors {enforcementLevel === 'optional' ? 'border-brand bg-brand/5' : 'hover:bg-muted/50'}"
      >
        <span class="text-xs font-semibold">可选</span>
        <p class="text-[10px] text-muted-foreground mt-1">用户可自行选择是否开启 MFA</p>
      </button>
      <button
        onclick={() => enforcementLevel = "required"}
        class="flex-1 p-3 rounded-lg border text-left transition-colors {enforcementLevel === 'required' ? 'border-brand bg-brand/5' : 'hover:bg-muted/50'}"
      >
        <span class="text-xs font-semibold">强制</span>
        <p class="text-[10px] text-muted-foreground mt-1">所有用户必须启用 MFA 才能登录</p>
      </button>
    </div>
  </div>

  <!-- MFA Factors -->
  <div class="space-y-3">
    <h3 class="text-sm font-semibold">验证方式</h3>
    {#each configs as cfg}
      <div class="rounded-xl border bg-card p-4 flex items-center justify-between hover:bg-muted/5 transition-colors">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg flex items-center justify-center {cfg.enabled ? 'bg-brand/10 text-brand' : 'bg-muted/50 text-muted-foreground'}">
            <cfg.icon size={16} />
          </div>
          <div>
            <span class="font-semibold text-sm">{cfg.name}</span>
            <p class="text-[10px] text-muted-foreground">{cfg.description}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-[10px] text-muted-foreground hidden md:block">{cfg.detail}</span>
          <button
            onclick={() => cfg.enabled = !cfg.enabled}
            class="relative w-10 h-5 rounded-full transition-colors {cfg.enabled ? 'bg-brand' : 'bg-muted'}"
            aria-label="切换 {cfg.name}"
          >
            <span class="absolute left-0.5 top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform {cfg.enabled ? 'translate-x-5' : ''}"></span>
          </button>
        </div>
      </div>
    {/each}
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Clock size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">MFA 验证的 Challenge 有效期为 300 秒（5 分钟），过期后需重新发起。TOTP 验证码有效期为 30 秒。</p>
  </div>
</div>
