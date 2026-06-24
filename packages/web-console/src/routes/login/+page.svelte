<script lang="ts">
  import { apiClient } from "$lib/api";
  import { mode, toggleMode } from "mode-watcher";
  import { t, locale } from "svelte-i18n";
  import { Loader2, Lock, Eye, EyeOff, User, Globe, Sun, Moon, Info } from "lucide-svelte";

  let username = $state("");
  let password = $state("");
  let isLoading = $state(false);
  let error: string | null = $state.raw(null);
  let showPassword = $state(false);
  let isShaking = $state(false);

  // 触发物理卡片抖动反馈
  function triggerShake() {
    isShaking = false;
    // 强制触发重绘以重启 CSS 动画
    setTimeout(() => {
      isShaking = true;
    }, 10);
  }

  async function handleLogin() {
    if (!username.trim() || !password.trim()) {
      error = $t("Login.error_empty") || "请输入用户名和密码";
      triggerShake();
      return;
    }
    isLoading = true;
    error = null;
    try {
      const res = await apiClient("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password: password.trim() })
      });
      const data = await res.json();
      if (data.success && data.token) {
        localStorage.setItem("supacloud_session", data.token);
        window.location.href = "/";
      } else {
        error = data.error || "登录失败";
        triggerShake();
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err) || "网络错误";
      triggerShake();
    } finally {
      isLoading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") handleLogin();
  }

  function toggleLanguage() {
    locale.set(($locale ?? "zh-CN").toLowerCase().startsWith("zh") ? "en" : "zh-CN");
  }
</script>

<div class="relative min-h-screen flex flex-col items-center justify-center bg-zinc-50 dark:bg-[#09090b] overflow-hidden select-none transition-colors duration-500">
  <!-- 极致 Dot-Grid 科技微网格底图 -->
  <div class="absolute inset-0 bg-[radial-gradient(#00000003_1px,transparent_1px)] dark:bg-[radial-gradient(#ffffff05_1px,transparent_1px)] bg-zinc-50 dark:bg-[#09090b] [background-size:16px_16px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] pointer-events-none transition-colors duration-500">
  </div>
  
  <!-- 朦胧流光渐变圆圈 (致敬极客冷光氛围) -->
  <div class="absolute -top-[30%] -left-[20%] w-[60%] h-[60%] rounded-full bg-brand/[0.04] dark:bg-brand/10 blur-[120px] pointer-events-none animate-pulse duration-[8s]"></div>
  <div class="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-purple-500/[0.02] dark:bg-purple-500/5 blur-[120px] pointer-events-none animate-pulse duration-[10s]"></div>

  <!-- 右上角多功能状态工具栏 -->
  <div class="absolute top-6 right-6 flex items-center gap-2">
    <!-- 语言切换 (中 / EN) -->
    <button
      onclick={toggleLanguage}
      class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-100/80 dark:bg-zinc-900/60 hover:bg-zinc-200 dark:hover:bg-zinc-800/80 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-800/80 backdrop-blur-md transition-all active:scale-[0.97] cursor-pointer"
    >
      <Globe size={13} />
      <span>{($locale ?? "zh-CN").toLowerCase().startsWith("zh") ? "EN" : "中文"}</span>
    </button>

    <!-- 亮暗主题切换 -->
    <button
      onclick={toggleMode}
      class="p-2 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800/80 rounded-lg bg-zinc-100/80 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800/80 backdrop-blur-md transition-all active:scale-[0.97] cursor-pointer"
    >
      {#if mode.current === "dark"}
        <Sun size={14} />
      {:else}
        <Moon size={14} />
      {/if}
    </button>
  </div>

  <!-- 页面主体容器 -->
  <div class="relative w-full max-w-[400px] px-6 py-12 flex flex-col items-center">
    
    <!-- Supa-Lightning Logo 与排版区 -->
    <div class="mb-6 flex flex-col items-center text-center">
      <div class="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-brand/20 via-brand/10 to-emerald-500/5 flex items-center justify-center mb-4 border border-brand/30 shadow-[0_8px_30px_rgba(16,185,129,0.15)] group overflow-hidden">
        <!-- 扫光流动动效 -->
        <div class="absolute inset-0 bg-gradient-to-tr from-transparent via-brand/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000 ease-out"></div>
        <!-- 闪电几何线条 (向 Supabase 致敬，展现几何力量感) -->
        <svg class="w-7 h-7 text-brand filter drop-shadow-[0_2px_8px_rgba(16,185,129,0.4)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </div>
      <h1 class="text-2xl font-bold tracking-tight text-zinc-900 dark:text-transparent bg-clip-text dark:bg-gradient-to-b dark:from-zinc-50 dark:to-zinc-300">SupaCloud Studio</h1>
      <p class="text-[13px] text-zinc-500 dark:text-zinc-400 mt-1 font-medium">{$t("Login.title") || "请登录以访问管理控制台"}</p>
    </div>

    <!-- 极致 Supabase 碳黑高对比卡片 -->
    <div 
      class="w-full rounded-2xl border border-zinc-200 dark:border-zinc-850 bg-white dark:bg-[#161616] p-7 space-y-5 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.6)] dark:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.03)] transition-all duration-300"
      class:animate-shake={isShaking}
    >
      <!-- 情感化渐变报错条 -->
      {#if error}
        <div class="rounded-xl bg-red-500/5 border border-red-500/20 px-4 py-3 text-xs text-red-600 dark:text-red-400 font-semibold flex items-center gap-2.5 shadow-[inset_0_1px_0_rgba(239,68,68,0.05)] animate-fade-in">
          <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping"></span>
          <span>{error}</span>
        </div>
      {/if}

      <!-- 用户名 (高对比度干练字段) -->
      <div class="space-y-1.5">
        <label for="login-username" class="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider block">{$t("Login.username") || "用户名"}</label>
        <div class="relative group">
          <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-600 group-focus-within:text-brand transition-colors duration-300">
            <User size={15} />
          </span>
          <input
            id="login-username"
            bind:value={username}
            onkeydown={handleKeydown}
            placeholder={$t("Login.username_placeholder") || "admin"}
            autocomplete="username"
            class="w-full pl-10 pr-4 py-3 text-sm rounded-xl border border-zinc-250 dark:border-zinc-800 bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-zinc-100 placeholder-zinc-450 dark:placeholder-zinc-650 focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand/10 dark:focus:ring-brand/5 transition-all duration-300"
          />
        </div>
      </div>

      <!-- 密码 (高对比度干练字段) -->
      <div class="space-y-1.5">
        <label for="login-password" class="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider block">{$t("Login.password") || "密码"}</label>
        <div class="relative group">
          <span class="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-600 group-focus-within:text-brand transition-colors duration-300">
            <Lock size={15} />
          </span>
          <input
            id="login-password"
            type={showPassword ? "text" : "password"}
            bind:value={password}
            onkeydown={handleKeydown}
            placeholder={$t("Login.password_placeholder") || "••••••••"}
            autocomplete="current-password"
            class="w-full pl-10 pr-11 py-3 text-sm rounded-xl border border-zinc-250 dark:border-zinc-800 bg-zinc-50 dark:bg-[#1e1e1e] text-zinc-900 dark:text-zinc-100 placeholder-zinc-450 dark:placeholder-zinc-650 focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand/10 dark:focus:ring-brand/5 transition-all duration-300"
          />
          <button
            type="button"
            onclick={() => showPassword = !showPassword}
            class="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-550 hover:text-zinc-800 dark:hover:text-zinc-300 transition-colors p-1.5 rounded-lg hover:bg-zinc-200/50 dark:hover:bg-zinc-800/30"
          >
            {#if showPassword}<EyeOff size={15} />{:else}<Eye size={15} />{/if}
          </button>
        </div>
      </div>

      <!-- 翠绿物理弹性高对比按钮 -->
      <button
        onclick={handleLogin}
        disabled={isLoading}
        class="relative w-full py-3 text-[13px] font-bold rounded-xl bg-brand text-[#121212] hover:bg-brand/90 transition-all duration-300 flex items-center justify-center gap-2 disabled:opacity-50 shadow-[0_4px_20px_rgba(62,207,142,0.2)] hover:shadow-[0_6px_24px_rgba(62,207,142,0.3)] active:scale-[0.98] select-none cursor-pointer"
      >
        {#if isLoading}
          <Loader2 size={16} class="animate-spin text-[#121212]" />
          <span>{$t("Login.logging_in") || "正在登录..."}</span>
        {:else}
          <Lock size={14} strokeWidth={2.5} />
          <span>{$t("Login.login_btn") || "登录"}</span>
        {/if}
      </button>
    </div>

    <!-- 极度低调内敛的登录提示 -->
    <div class="w-full mt-7 bg-zinc-100/50 dark:bg-zinc-900/40 border border-dashed border-zinc-200 dark:border-zinc-800/80 rounded-2xl p-4 text-[11px] text-zinc-500 dark:text-zinc-400 flex items-start gap-3 text-left">
      <div class="mt-0.5 text-zinc-400 dark:text-zinc-500 shrink-0">
        <Info size={14} />
      </div>
      <div class="space-y-1 leading-relaxed">
        <p class="font-bold text-zinc-600 dark:text-zinc-400">{$t("Login.credentials_hint_title") || "使用安装时配置的 Dashboard 凭据"}</p>
        <p class="text-[10px] text-zinc-400 dark:text-zinc-550 opacity-90">{$t("Login.env_modify_hint") || "可通过环境变量 DASHBOARD_USERNAME / DASHBOARD_PASSWORD 或 STUDIO_USERNAME / STUDIO_PASSWORD 修改"}</p>
      </div>
    </div>
    
  </div>
</div>

<style>
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
    20%, 40%, 60%, 80% { transform: translateX(4px); }
  }

  .animate-shake {
    animation: shake 0.4s cubic-bezier(.36,.07,.19,.97) both;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .animate-fade-in {
    animation: fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
</style>
