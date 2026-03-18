<script lang="ts">
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import { Loader2, Copy, Eye, EyeOff, Tag, Link2 } from "lucide-svelte";

  let project = $state<any>(null);
  let isLoading = $state(true);
  let showAnonKey = $state(false);
  let showServiceKey = $state(false);

  const projectRef = $derived(page.params.ref);
  const hostname = $derived(page.url?.hostname || "localhost");
  const apiUrl = $derived(`http://${hostname}:8000`);

  async function fetchProject() {
    isLoading = true;
    try {
      const res = await fetch(`/v1/projects/${projectRef}`);
      project = await res.json();
    } catch (err) {
      console.error("Failed to fetch project:", err);
    } finally {
      isLoading = false;
    }
  }

  onMount(() => { fetchProject(); });

  async function copyToClipboard(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }
</script>

<div class="flex flex-col space-y-6">
  <p class="text-sm text-muted-foreground">项目 URL 和 API 密钥，用于访问数据库和连接服务。</p>

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if project}
    <div class="space-y-6">
      <!-- Project URL -->
      <div class="border rounded-xl bg-card overflow-hidden">
        <div class="border-b px-6 py-4 bg-muted/20">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <Link2 size={18} />
            项目 URL
          </h2>
          <p class="text-xs text-muted-foreground mt-1">用于查询和管理数据库的 RESTful 端点</p>
        </div>
        <div class="p-6">
          <div class="flex items-center gap-2">
            <div class="flex-1 px-3 py-2 text-sm font-mono rounded-lg border bg-muted/30 text-foreground overflow-hidden text-ellipsis">
              {apiUrl}
            </div>
            <button
              onclick={() => copyToClipboard(apiUrl)}
              class="px-4 py-2 text-sm font-medium rounded-lg border bg-background hover:bg-muted/50 transition-colors flex items-center gap-2"
            >
              <Copy size={16} />
              复制
            </button>
          </div>
        </div>
      </div>

      <!-- API Keys -->
      <div class="border rounded-xl bg-card overflow-hidden">
        <div class="border-b px-6 py-4 bg-muted/20">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <Tag size={18} />
            项目 API 密钥
          </h2>
          <p class="text-xs text-muted-foreground mt-1">用于认证请求的 API 密钥</p>
        </div>

        <div class="divide-y divide-border/50">
          <!-- anon public -->
          <div class="p-6 space-y-3">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-green-500/10 text-green-600">anon</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-500/10 text-blue-600">public</span>
            </div>
            <p class="text-xs text-muted-foreground">此密钥可安全用于浏览器端，前提是你已为所有表启用了行级安全 (RLS) 并配置了策略。</p>
            <div class="flex items-start gap-2">
              <div class="flex-1">
                <textarea readonly rows="3"
                  class="w-full px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 text-foreground resize-none focus:outline-none"
                  style={!showAnonKey ? "-webkit-text-security: disc;" : ""}
                >{project.anon_key || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}</textarea>
              </div>
              <div class="flex flex-col gap-2 shrink-0">
                <button onclick={() => copyToClipboard(project.anon_key || "")}
                  class="px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors" title="复制">
                  <Copy size={14} />
                </button>
                <button onclick={() => showAnonKey = !showAnonKey}
                  class="px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors"
                  title={showAnonKey ? "隐藏" : "显示"}>
                  {#if showAnonKey}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
                </button>
              </div>
            </div>
          </div>

          <!-- service_role secret -->
          <div class="p-6 space-y-3">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/10 text-amber-600">service_role</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-red-500/10 text-red-600">secret</span>
            </div>
            <p class="text-xs text-muted-foreground">此密钥可绕过行级安全策略，请勿公开分享。</p>
            <div class="flex items-start gap-2">
              <div class="flex-1">
                <textarea readonly rows="3"
                  class="w-full px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 text-foreground resize-none focus:outline-none"
                  style={!showServiceKey ? "-webkit-text-security: disc;" : ""}
                >{project.service_role_key || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."}</textarea>
              </div>
              <div class="flex flex-col gap-2 shrink-0">
                <button onclick={() => copyToClipboard(project.service_role_key || "")}
                  class="px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors" title="复制">
                  <Copy size={14} />
                </button>
                <button onclick={() => showServiceKey = !showServiceKey}
                  class="px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors"
                  title={showServiceKey ? "隐藏" : "显示"}>
                  {#if showServiceKey}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
