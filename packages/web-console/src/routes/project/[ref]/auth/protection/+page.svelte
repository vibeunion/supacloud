<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Shield, Ban, AlertTriangle, Globe, Lock, Loader2 } from "lucide-svelte";

  const projectRef = $derived(page.params.ref);

  interface ProtectionConfig {
    key: string;
    name: string;
    description: string;
    icon: any;
    enabled: boolean;
    detail: string;
  }

  let configs = $state<ProtectionConfig[]>([
    { key: "SECURITY_CAPTCHA_ENABLED", name: "Bot Detection", description: "使用 CAPTCHA 防止自动化机器人攻击", icon: Shield, enabled: false, detail: "支持 hCaptcha 和 Cloudflare Turnstile" },
    { key: "SECURITY_IP_RESTRICTION_ENABLED", name: "IP 限制", description: "限制特定 IP 或 CIDR 范围访问认证 API", icon: Ban, enabled: false, detail: "可设置白名单和黑名单" },
    { key: "PASSWORD_HIBC_ENABLE", name: "泄露密码检测", description: "阻止使用已知泄露密码进行注册", icon: Lock, enabled: true, detail: "使用 HaveIBeenPwned 数据库检查" },
    { key: "PASSWORD_STRENGTH_REQUIRE_COMPLEXITY", name: "强密码策略", description: "要求密码满足复杂度要求（长度、大小写、数字、特殊字符）", icon: Lock, enabled: true, detail: "最小 8 个字符" },
    { key: "SECURITY_LOCKOUT_ENABLED", name: "登录失败锁定", description: "连续登录失败后临时锁定账户", icon: Ban, enabled: false, detail: "默认：5 次失败后锁定 15 分钟" },
    { key: "SECURITY_CORS_RESTRICTION_ENABLED", name: "CORS 限制", description: "限制允许的跨域请求来源", icon: Globe, enabled: true, detail: "默认允许所有域名" },
  ]);

  let isLoading = $state(true);
  let isSaving = $state(false);
  let saveMsg = $state<string | null>(null);

  async function fetchConfig() {
    isLoading = true;
    try {
      const res = await fetch(`/v1/projects/${projectRef}/auth/config`);
      if (res.ok) {
        const configData = await res.json();
        for (const cfg of configs) {
          if (configData[cfg.key] !== undefined) {
            cfg.enabled = String(configData[cfg.key]) === "true";
          }
        }
      }
    } catch (err) {
      console.error("Failed to fetch protection config", err);
    } finally {
      isLoading = false;
    }
  }

  onMount(() => { fetchConfig(); });

  async function toggleConfig(index: number) {
    if (isSaving) return;
    isSaving = true;
    saveMsg = null;
    
    const cfg = configs[index];
    const originalValue = cfg.enabled;
    // Optimistic update
    cfg.enabled = !cfg.enabled;

    try {
      const res = await fetch(`/v1/projects/${projectRef}/auth/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [cfg.key]: String(cfg.enabled) })
      });
      
      if (res.ok) {
        saveMsg = `✅ ${cfg.name} 已${cfg.enabled ? '启用' : '完全禁用'} (GoTrue重启中)`;
        setTimeout(() => saveMsg = null, 3000);
      } else {
        throw new Error("Failed to save");
      }
    } catch (err) {
      // Revert on failure
      cfg.enabled = originalValue;
      saveMsg = `❌ 保存失败`;
      setTimeout(() => saveMsg = null, 3000);
    } finally {
      isSaving = false;
    }
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">安全防护</h1>
    <p class="text-sm text-muted-foreground mt-1">配置认证安全防护措施和攻击防御</p>
  </div>

  <div class="rounded-lg border bg-amber-500/5 border-amber-500/20 p-3 flex items-start gap-2">
    <AlertTriangle size={14} class="text-amber-600 mt-0.5 shrink-0" />
    <p class="text-xs text-amber-700">这些设置影响所有认证端点的安全行为。修改前请确保了解对现有用户的影响。</p>
  </div>

  {#if saveMsg}
    <div class="rounded-lg border {saveMsg.includes('错误') || saveMsg.includes('失败') ? 'bg-red-500/10 border-red-500/20 text-red-600' : 'bg-green-500/10 border-green-500/20 text-green-600'} px-4 py-2 text-xs font-medium">
      {saveMsg}
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center justify-center py-20">
      <Loader2 size={24} class="animate-spin text-muted-foreground opacity-50" />
    </div>
  {:else}
    <div class="space-y-3">
      {#each configs as _, i}
        {@const cfg = configs[i]}
        <div class="rounded-xl border bg-card p-4 flex items-center justify-between hover:bg-muted/5 transition-colors">
          <div class="flex items-center gap-3">
            <div class="w-9 h-9 rounded-lg flex items-center justify-center {cfg.enabled ? 'bg-green-500/10 text-green-600' : 'bg-muted/50 text-muted-foreground'}">
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
              onclick={() => toggleConfig(i)}
              disabled={isSaving}
              class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full focus:outline-none focus:ring-2 focus:ring-brand focus:ring-offset-2 {cfg.enabled ? 'bg-brand' : 'bg-muted-foreground/30'} transition-colors disabled:opacity-50"
            >
              <span class="sr-only">Use setting</span>
              <span aria-hidden="true" class="pointer-events-none absolute left-0 inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition-transform duration-200 ease-in-out {cfg.enabled ? 'translate-x-4' : 'translate-x-0.5'}"></span>
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>
