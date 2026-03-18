<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, Clock, Shield, RefreshCw, Timer, Fingerprint } from "lucide-svelte";

  interface SessionConfig {
    name: string;
    description: string;
    value: string;
    icon: typeof Clock;
  }

  const SESSION_CONFIGS: SessionConfig[] = [
    { name: "JWT expiry time", description: "JWT Token 的有效期", value: "3600", icon: Clock },
    { name: "Refresh token rotation", description: "启用 Refresh Token 自动轮换，增强安全性", value: "已启用", icon: RefreshCw },
    { name: "Refresh token reuse interval", description: "Refresh Token 可被重复使用的时间窗口（秒）", value: "10", icon: Timer },
    { name: "Single session per user", description: "限制每个用户只能有一个活跃会话", value: "未启用", icon: Shield },
    { name: "MFA (多因素认证)", description: "要求用户进行额外的身份验证", value: "可选", icon: Fingerprint },
    { name: "Session timeout", description: "会话非活动超时时间", value: "604800", icon: Clock },
  ];

  let configs = $state<SessionConfig[]>([...SESSION_CONFIGS]);
  let isLoading = $state(true);

  const projectRef = $derived(page.params.ref);

  onMount(() => {
    setTimeout(() => { isLoading = false; }, 300);
  });

  function formatSeconds(val: string): string {
    const num = parseInt(val);
    if (isNaN(num)) return val;
    if (num >= 86400) return `${(num / 86400).toFixed(0)} 天`;
    if (num >= 3600) return `${(num / 3600).toFixed(0)} 小时`;
    if (num >= 60) return `${(num / 60).toFixed(0)} 分钟`;
    return `${num} 秒`;
  }
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">会话管理</h1>
    <p class="text-sm text-muted-foreground mt-1">管理用户会话、JWT 配置和 Token 轮换策略</p>
  </div>

  <div class="flex-1">
    {#if isLoading}
      <div class="rounded-xl border bg-card flex flex-col items-center justify-center py-24 text-muted-foreground gap-3">
        <Loader2 size={32} class="animate-spin text-brand opacity-50" />
        <p class="text-xs font-mono uppercase tracking-widest">正在加载会话配置...</p>
      </div>
    {:else}
      <div class="space-y-3">
        {#each configs as cfg}
          <div class="rounded-xl border bg-card p-5 hover:border-brand/20 transition-colors">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-lg bg-brand/10 text-brand flex items-center justify-center">
                  <cfg.icon size={16} />
                </div>
                <div>
                  <span class="font-semibold text-sm">{cfg.name}</span>
                  <p class="text-[10px] text-muted-foreground mt-0.5">{cfg.description}</p>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <div class="px-3 py-1.5 rounded-lg bg-muted/30 border">
                  <span class="font-mono font-bold text-sm">{cfg.value}</span>
                  {#if !isNaN(parseInt(cfg.value))}
                    <span class="text-[10px] text-muted-foreground ml-1">({formatSeconds(cfg.value)})</span>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
