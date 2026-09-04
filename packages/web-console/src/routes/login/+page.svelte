<script lang="ts">
  import { getStudioSession, loginStudio } from "$lib/api";
  import { onMount } from "svelte";
  import { mode, toggleMode } from "mode-watcher";
  import { t, locale } from "svelte-i18n";
  import { Loader2, Lock, Eye, EyeOff, User, Globe, Sun, Moon, Info } from "lucide-svelte";

  const CONSOLE_LANDING_PATH = "/projects";

  let username = $state("");
  let password = $state("");
  let isLoading = $state(false);
  let error: string | null = $state.raw(null);
  let showPassword = $state(false);
  let isShaking = $state(false);

  onMount(() => {
    let isMounted = true;

    void getStudioSession()
      .then((session) => {
        if (isMounted && session.authenticated) {
          window.location.replace(CONSOLE_LANDING_PATH);
        }
      })
      .catch(() => {
        // Keep login page on session probe failure, allowing user to log in normally.
      });

    return () => {
      isMounted = false;
    };
  });

  // Trigger card shake animation feedback
  function triggerShake() {
    isShaking = false;
    // Force reflow to restart CSS animation
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
      const result = await loginStudio(username.trim(), password);
      if (result.success) {
        window.location.href = CONSOLE_LANDING_PATH;
      } else {
        error = result.error || "登录失败";
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
  <!-- Tech dot-grid background -->
  <div class="absolute inset-0 bg-[radial-gradient(#00000003_1px,transparent_1px)] dark:bg-[radial-gradient(#ffffff05_1px,transparent_1px)] bg-zinc-50 dark:bg-[#09090b] [background-size:16px_16px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_50%,#000_70%,transparent_100%)] pointer-events-none transition-colors duration-500">
  </div>
  
  <!-- Soft glowing gradient circle (geek ambient backlight) -->
  <div class="absolute -top-[30%] -left-[20%] w-[60%] h-[60%] rounded-full bg-brand/[0.04] dark:bg-brand/10 blur-[120px] pointer-events-none animate-pulse duration-[8s]"></div>
  <div class="absolute -bottom-[20%] -right-[10%] w-[50%] h-[50%] rounded-full bg-purple-500/[0.02] dark:bg-purple-500/5 blur-[120px] pointer-events-none animate-pulse duration-[10s]"></div>

  <!-- Top-right status toolbar -->
  <div class="absolute top-6 right-6 flex items-center gap-2">
    <!-- Language switcher (ZH / EN) -->
    <button
      onclick={toggleLanguage}
      class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-zinc-100/80 dark:bg-zinc-900/60 hover:bg-zinc-200 dark:hover:bg-zinc-800/80 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-800/80 backdrop-blur-md transition-all active:scale-[0.97] cursor-pointer"
    >
      <Globe size={13} />
      <span>{($locale ?? "zh-CN").toLowerCase().startsWith("zh") ? "EN" : "中文"}</span>
    </button>

    <!-- Dark/light theme toggle -->
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

  <!-- Main page container -->
  <div class="relative w-full max-w-[400px] px-6 py-12 flex flex-col items-center">
    
    <!-- Supa-Lightning logo and header area -->
    <div class="mb-6 flex flex-col items-center text-center">
      <div class="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-brand/20 via-brand/10 to-emerald-500/5 flex items-center justify-center mb-4 border border-brand/30 shadow-[0_8px_30px_rgba(16,185,129,0.15)] group overflow-hidden">
        <!-- Light sweep animation effect -->
        <div class="absolute inset-0 bg-gradient-to-tr from-transparent via-brand/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000 ease-out"></div>
        <!-- Lightning bolt geometric icon -->
        <svg class="w-7 h-7 text-brand filter drop-shadow-[0_2px_8px_rgba(16,185,129,0.4)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
        </svg>
      </div>
      <h1 class="text-2xl font-bold tracking-tight text-zinc-900 dark:text-transparent bg-clip-text dark:bg-gradient-to-b dark:from-zinc-50 dark:to-zinc-300">SupaCloud Studio</h1>
      <p class="text-[13px] text-zinc-500 dark:text-zinc-400 mt-1 font-medium">{$t("Login.title") || "请登录以访问管理控制台"}</p>
    </div>

    <!-- Carbon dark high-contrast card -->
    <div 
      class="w-full rounded-2xl border border-zinc-200 dark:border-zinc-850 bg-white dark:bg-[#161616] p-7 space-y-5 shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05),inset_0_1px_0_rgba(255,255,255,0.6)] dark:shadow-[0_30px_60px_-15px_rgba(0,0,0,0.8),inset_0_1px_0_rgba(255,255,255,0.03)] transition-all duration-300"
      class:animate-shake={isShaking}
    >
      <!-- Gradient error alert banner -->
      {#if error}
        <div class="rounded-xl bg-red-500/5 border border-red-500/20 px-4 py-3 text-xs text-red-600 dark:text-red-400 font-semibold flex items-center gap-2.5 shadow-[inset_0_1px_0_rgba(239,68,68,0.05)] animate-fade-in">
          <span class="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping"></span>
          <span>{error}</span>
        </div>
      {/if}

      <!-- Username input field -->
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

      <!-- Password input field -->
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

      <!-- Brand action button -->
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

    <!-- Login hints container -->
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
