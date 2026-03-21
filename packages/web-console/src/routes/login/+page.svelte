<script lang="ts">
  import { apiClient } from "$lib/api";

  import { Loader2, Lock, Eye, EyeOff } from "lucide-svelte";

  let username = $state("");
  let password = $state("");
  let isLoading = $state(false);
  let error: string | null = $state.raw(null);
  let showPassword = $state(false);

  async function handleLogin() {
    if (!username.trim() || !password.trim()) {
      error = "请输入用户名和密码";
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
      if (data.success) {
        localStorage.setItem("supacloud_session", data.token);
        localStorage.setItem("supacloud_master_token", data.masterToken);
        window.location.href = "/";
      } else {
        error = data.error || "登录失败";
      }
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err) || "网络错误";
    } finally {
      isLoading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") handleLogin();
  }
</script>

<div class="min-h-screen flex items-center justify-center bg-background">
  <div class="w-full max-w-sm">
    <!-- Logo -->
    <div class="text-center mb-8">
      <div class="w-16 h-16 rounded-2xl bg-brand/10 flex items-center justify-center mx-auto mb-4 border border-brand/20">
        <span class="text-2xl font-black text-brand">SC</span>
      </div>
      <h1 class="text-2xl font-bold tracking-tight">SupaCloud Studio</h1>
      <p class="text-sm text-muted-foreground mt-1">请登录以访问管理控制台</p>
    </div>

    <!-- Login Form -->
    <div class="rounded-xl border bg-card shadow-lg p-6 space-y-4">
      {#if error}
        <div class="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-2.5 text-xs text-red-600 font-medium">
          {error}
        </div>
      {/if}

      <div>
        <label for="login-username" class="text-xs font-semibold text-muted-foreground block mb-1.5">用户名</label>
        <input
          id="login-username"
          bind:value={username}
          onkeydown={handleKeydown}
          placeholder="admin"
          autocomplete="username"
          class="w-full px-3 py-2.5 text-sm rounded-lg border bg-muted/30 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-all"
        />
      </div>

      <div>
        <label for="login-password" class="text-xs font-semibold text-muted-foreground block mb-1.5">密码</label>
        <div class="relative">
          <input
            id="login-password"
            type={showPassword ? "text" : "password"}
            bind:value={password}
            onkeydown={handleKeydown}
            placeholder="••••••••"
            autocomplete="current-password"
            class="w-full px-3 py-2.5 pr-10 text-sm rounded-lg border bg-muted/30 focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand transition-all"
          />
          <button
            type="button"
            onclick={() => showPassword = !showPassword}
            class="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
          >
            {#if showPassword}<EyeOff size={16} />{:else}<Eye size={16} />{/if}
          </button>
        </div>
      </div>

      <button
        onclick={handleLogin}
        disabled={isLoading}
        class="w-full px-4 py-2.5 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-md shadow-brand/20"
      >
        {#if isLoading}<Loader2 size={16} class="animate-spin" />{:else}<Lock size={16} />{/if}
        登录
      </button>
    </div>

    <p class="text-center text-[10px] text-muted-foreground/50 mt-6">
      默认凭据: admin / supacloud · 可通过环境变量 STUDIO_USERNAME / STUDIO_PASSWORD 修改
    </p>
  </div>
</div>
