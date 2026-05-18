<script lang="ts">
  import { onMount } from "svelte";
  import { apiClient } from "$lib/api";
  import { Save, RefreshCw, Bot, Key, Globe, Cpu, CheckCircle, AlertTriangle } from "lucide-svelte";
  import { locale } from "svelte-i18n";

  interface SettingItem {
    key: string;
    value: string;
    description: string | null;
    is_secret: boolean;
    updated_at: string;
  }

  // Form state
  let aiApiBase = $state("");
  let aiApiKey = $state("");
  let aiModel = $state("");

  // UI state
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);
  let testResult = $state<{ ok: boolean; message: string } | null>(null);
  let saveSuccess = $state(false);
  const isZh = $derived(($locale ?? "").toLowerCase().startsWith("zh"));
  const tr = (zh: string, en: string) => isZh ? zh : en;

  // Preset providers
  const PROVIDERS = [
    { labelZh: "OpenAI", labelEn: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    { labelZh: "DeepSeek", labelEn: "DeepSeek", base: "https://api.deepseek.com/v1", model: "deepseek-chat" },
    { labelZh: "通义千问", labelEn: "Qwen", base: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
    { labelZh: "Moonshot", labelEn: "Moonshot", base: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
    { labelZh: "硅基流动", labelEn: "SiliconFlow", base: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3-8B" },
  ];

  async function loadSettings() {
    loading = true;
    try {
      const response = await apiClient("/v1/platform/settings");
      const res = await response.json() as { data?: SettingItem[] };
      const items: SettingItem[] = res.data || [];
      for (const item of items) {
        if (item.key === "ai_api_base") aiApiBase = item.value;
        if (item.key === "ai_api_key") aiApiKey = item.value;
        if (item.key === "ai_model") aiModel = item.value;
      }
    } catch {
      // First time, no settings yet
    }
    loading = false;
  }

  async function saveSettings() {
    saving = true;
    saveSuccess = false;
    try {
      await apiClient("/v1/platform/settings", {
        method: "PUT",
        body: JSON.stringify({
          items: [
            { key: "ai_api_base", value: aiApiBase, description: "AI API Base URL", is_secret: false },
            ...(aiApiKey && !aiApiKey.startsWith("••") ? [{ key: "ai_api_key", value: aiApiKey, description: "AI API Key", is_secret: true }] : []),
            { key: "ai_model", value: aiModel, description: "Default AI Model", is_secret: false },
          ],
        }),
      });
      saveSuccess = true;
      setTimeout(() => (saveSuccess = false), 3000);
    } catch (err: unknown) {
      alert(tr("保存失败: ", "Save failed: ") + (err instanceof Error ? err.message : String(err)));
    }
    saving = false;
  }

  async function testConnection() {
    testing = true;
    testResult = null;
    try {
      const response = await apiClient("/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: aiModel || "gpt-4o-mini",
          messages: [{ role: "user", content: "Say hello in 5 words" }],
          stream: false,
          max_tokens: 30,
        }),
      });
      const res = await response.json() as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
      if (res?.choices?.[0]?.message?.content) {
        testResult = { ok: true, message: `✅ ${tr("连接成功！AI 回复: ", "Connected successfully! AI replied: ")}"${res.choices[0].message.content}"` };
      } else {
        testResult = { ok: false, message: tr("返回格式异常：", "Unexpected response format: ") + JSON.stringify(res).slice(0, 200) };
      }
    } catch (err: unknown) {
      testResult = { ok: false, message: tr("连接失败: ", "Connection failed: ") + (err instanceof Error ? err.message : String(err)) };
    }
    testing = false;
  }

  function applyPreset(provider: typeof PROVIDERS[number]) {
    aiApiBase = provider.base;
    aiModel = provider.model;
  }

  onMount(loadSettings);
</script>

<div class="max-w-3xl mx-auto space-y-8">
  <!-- Header -->
  <div>
    <h2 class="text-2xl font-bold flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-brand to-purple-600 flex items-center justify-center shadow-lg">
        <Bot size={20} class="text-white" />
      </div>
      {tr("AI 服务配置", "AI Service Settings")}
    </h2>
    <p class="text-sm text-muted-foreground mt-2">{tr("配置平台内置 AI 助手使用的大语言模型接口地址与鉴权密钥。支持任何兼容 OpenAI 协议的服务商。", "Configure API base URL and keys for the built-in AI assistant. Supports any OpenAI-compatible provider.")}</p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-20 text-muted-foreground">
      <RefreshCw size={20} class="animate-spin mr-2" /> {tr("加载配置中...", "Loading settings...")}
    </div>
  {:else}
    <!-- Quick Provider Presets -->
    <div class="space-y-3">
      <span class="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{tr("快速选择服务商", "Quick provider presets")}</span>
      <div class="flex flex-wrap gap-2">
        {#each PROVIDERS as p}
          <button
            onclick={() => applyPreset(p)}
            class="px-4 py-2 text-xs font-medium rounded-xl border transition-all hover:border-brand hover:bg-brand/5 hover:text-brand hover:shadow-sm {aiApiBase === p.base ? 'border-brand bg-brand/10 text-brand shadow-sm' : 'bg-card text-muted-foreground'}"
          >
            {tr(p.labelZh, p.labelEn)}
          </button>
        {/each}
      </div>
    </div>

    <!-- Form -->
    <div class="space-y-5 rounded-2xl border bg-card p-6 shadow-sm">
      <!-- API Base -->
      <div class="space-y-2">
        <label for="ai-api-base" class="flex items-center gap-2 text-sm font-semibold">
          <Globe size={15} class="text-brand" /> {tr("API 接口地址", "API Base URL")}
        </label>
        <input
          id="ai-api-base"
          bind:value={aiApiBase}
          class="w-full px-4 py-2.5 text-sm font-mono rounded-xl border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 transition-shadow"
          placeholder="https://api.openai.com/v1"
        />
        <p class="text-[11px] text-muted-foreground">{tr("兼容 OpenAI 协议的 Chat Completions 端点地址（无需包含 /chat/completions 后缀）", "OpenAI-compatible Chat Completions base URL (without /chat/completions suffix)")}</p>
      </div>

      <!-- API Key -->
      <div class="space-y-2">
        <label for="ai-api-key" class="flex items-center gap-2 text-sm font-semibold">
          <Key size={15} class="text-amber-500" /> {tr("鉴权密钥 (API Key)", "API Key")}
        </label>
        <input
          id="ai-api-key"
          type="password"
          bind:value={aiApiKey}
          class="w-full px-4 py-2.5 text-sm font-mono rounded-xl border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 transition-shadow"
          placeholder="sk-..."
        />
        <p class="text-[11px] text-muted-foreground">{tr("密钥仅存储在您的服务器数据库中，通过后端代理访问，不会暴露给前端浏览器", "Keys are stored only in your server database and accessed via backend proxy, never exposed to browsers")}</p>
      </div>

      <!-- Model -->
      <div class="space-y-2">
        <label for="ai-model" class="flex items-center gap-2 text-sm font-semibold">
          <Cpu size={15} class="text-purple-500" /> {tr("默认模型", "Default Model")}
        </label>
        <input
          id="ai-model"
          bind:value={aiModel}
          class="w-full px-4 py-2.5 text-sm font-mono rounded-xl border bg-background focus:outline-none focus:ring-2 focus:ring-brand/50 transition-shadow"
          placeholder="gpt-4o-mini"
        />
        <p class="text-[11px] text-muted-foreground">{tr("AI 助手发送消息时使用的模型标识符，如 gpt-4o-mini、qwen-plus、deepseek-chat 等", "Model identifier used by the AI assistant, e.g. gpt-4o-mini, qwen-plus, deepseek-chat")}</p>
      </div>
    </div>

    <!-- Action buttons -->
    <div class="flex items-center gap-3">
      <button
        onclick={saveSettings}
        disabled={saving}
        class="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold rounded-xl bg-brand text-white shadow-md hover:shadow-lg hover:brightness-110 transition-all disabled:opacity-50"
      >
        {#if saving}
          <RefreshCw size={16} class="animate-spin" />
        {:else if saveSuccess}
          <CheckCircle size={16} />
        {:else}
          <Save size={16} />
        {/if}
        {saveSuccess ? tr("已保存", "Saved") : tr("保存配置", "Save Settings")}
      </button>

      <button
        onclick={testConnection}
        disabled={testing || !aiApiBase}
        class="flex items-center gap-2 px-6 py-2.5 text-sm font-semibold rounded-xl border hover:bg-muted/50 transition-all disabled:opacity-50"
      >
        {#if testing}
          <RefreshCw size={16} class="animate-spin" />
        {:else}
          <Bot size={16} />
        {/if}
        {tr("测试连接", "Test Connection")}
      </button>
    </div>

    <!-- Test Result -->
    {#if testResult}
      <div class="rounded-xl border p-4 text-sm {testResult.ok ? 'border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400' : 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400'}">
        <div class="flex items-start gap-2">
          {#if testResult.ok}
            <CheckCircle size={16} class="shrink-0 mt-0.5" />
          {:else}
            <AlertTriangle size={16} class="shrink-0 mt-0.5" />
          {/if}
          <span>{testResult.message}</span>
        </div>
      </div>
    {/if}
  {/if}
</div>
