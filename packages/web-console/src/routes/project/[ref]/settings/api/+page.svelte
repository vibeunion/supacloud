<script lang="ts">



  import { page } from "$app/state";
  import { apiClient } from "$lib/api";
  import { getProjectApiUrl } from "$lib/project-api-url";
  import { Loader2, Copy, Eye, EyeOff, Tag, Link2, ShieldAlert, Trash2, Plus } from "lucide-svelte";
  import { toast } from "svelte-sonner";
  import { getContext } from "svelte";

  import { useShow } from "@svadmin/core";

  let showAnonKey = $state(false);
  let showServiceKey = $state(false);

  let newPath = $state("");
  let newSecond = $state<number | "">("");
  let newMinute = $state<number | "">("");
  let newHour = $state<number | "">("");
  let isSubmittingLimit = $state(false);

  const projectRef = $derived(page.params.ref);

  const query = useShow({
    get resource() { return "v1/projects"; },
    get id() { return projectRef; }
  });

  const project = $derived(query.data?.data || {});
  const apiUrl = $derived(getProjectApiUrl(project));
  const publishableKey = $derived(String((project as Record<string, unknown>)?.publishable_key || ""));
  const isLoading = $derived(query.isLoading);

  async function copyToClipboard(text: string) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  const { refetch } = query;

  async function addCustomRateLimit() {
    if (!newPath) return toast.error("请输入基础路径 (例如 /rest/v1)");
    
    // Auto-fix path prefix if missing
    let targetPath = newPath.trim();
    if (!targetPath.startsWith("/")) {
        targetPath = "/" + targetPath;
    }

    try {
      isSubmittingLimit = true;
      const res = await apiClient(`/v1/projects/${projectRef}/gateway/custom-rate-limits`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: targetPath,
          second: newSecond || undefined,
          minute: newMinute || undefined,
          hour: newHour || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "添加失败");
      toast.success("限流规则添加成功");
      newPath = "";
      newSecond = "";
      newMinute = "";
      newHour = "";
      refetch();
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      isSubmittingLimit = false;
    }
  }

  async function removeCustomRateLimit(path: string) {
    if (!confirm(`确定要删除路径 ${path} 的限流规则吗？`)) return;
    try {
      const res = await apiClient(`/v1/projects/${projectRef}/gateway/custom-rate-limits`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "删除失败");
      toast.success("限流规则已删除");
      refetch();
    } catch (err: any) {
      toast.error(err.message);
    }
  }
</script>

<div class="flex flex-col space-y-6">
  <p class="text-sm text-muted-foreground">项目 URL 和 API 密钥，用于访问数据库和连接服务。</p>

  {#if isLoading}
    <div class="flex items-center justify-center py-24">
      <Loader2 size={32} class="animate-spin text-brand opacity-50" />
    </div>
  {:else if query.isSuccess}
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
          <!-- publishable opaque key -->
          <div class="p-6 space-y-3">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/10 text-emerald-600">publishable</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-500/10 text-blue-600">recommended</span>
            </div>
            <p class="text-xs text-muted-foreground">推荐用于浏览器和移动客户端。网关会将其映射为 anon 权限，RLS 策略仍然生效。</p>
            <div class="flex items-start gap-2">
              <textarea readonly rows="2"
                class="w-full flex-1 px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 text-foreground resize-none focus:outline-none"
              >{publishableKey || "项目升级后将自动生成 sb_publishable_..."}</textarea>
              <button onclick={() => copyToClipboard(publishableKey)} disabled={!publishableKey}
                class="px-3 py-2 text-xs rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-40" title="复制">
                <Copy size={14} />
              </button>
            </div>
          </div>

          <!-- secret opaque key -->
          <div class="p-6 space-y-3">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-red-500/10 text-red-600">secret</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/10 text-amber-600">server only</span>
            </div>
            <p class="text-xs text-muted-foreground">Secret Key 映射为 service_role 权限，只在项目创建或密钥轮换响应中返回明文，请保存到服务端密钥管理系统。</p>
            <div class="px-3 py-2 text-xs font-mono rounded-lg border bg-muted/30 text-muted-foreground">sb_secret_••••••••••••••••••••••••</div>
          </div>

          <!-- anon public -->
          <div class="p-6 space-y-3">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-green-500/10 text-green-600">anon</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-500/10 text-blue-600">legacy</span>
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
                <button onclick={() => copyToClipboard(String((project as Record<string, unknown>)?.anon_key || ""))}
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
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-red-500/10 text-red-600">legacy secret</span>
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
                <button onclick={() => copyToClipboard(String((project as Record<string, unknown>)?.service_role_key || ""))}
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

      <!-- Custom Rate Limits -->
      <div class="border rounded-xl bg-card overflow-hidden">
        <div class="border-b px-6 py-4 bg-muted/20">
          <h2 class="text-lg font-semibold flex items-center gap-2">
            <ShieldAlert size={18} />
            自定义路由限流
          </h2>
          <p class="text-xs text-muted-foreground mt-1">控制特定接口路径的调用频率，防范恶意滥用并保护底层数据库资源。最高不可突破平台兜底限制 (100/秒，2000/分钟)。每个项目最多配置 20 条自定义限制。</p>
        </div>

        <div class="p-6 space-y-4">
          <!-- Existing Limits -->
          {#if Object.keys((project.rate_limits || {})).length > 0}
            <div class="rounded-lg border overflow-hidden">
              <table class="w-full text-sm text-left">
                <thead class="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th class="px-4 py-3 font-medium">路由路径 (Path)</th>
                    <th class="px-4 py-3 font-medium">每秒限制 (Second)</th>
                    <th class="px-4 py-3 font-medium">每分钟限制 (Minute)</th>
                    <th class="px-4 py-3 font-medium">每小时限制 (Hour)</th>
                    <th class="px-4 py-3 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  {#each Object.entries(project.rate_limits || {}) as [path, limits] (path)}
                    <tr class="hover:bg-muted/20">
                      <td class="px-4 py-3 font-mono text-xs">{path}</td>
                      <td class="px-4 py-3">{(limits as any).second || "-"}</td>
                      <td class="px-4 py-3">{(limits as any).minute || "-"}</td>
                      <td class="px-4 py-3">{(limits as any).hour || "-"}</td>
                      <td class="px-4 py-3 text-right">
                        <button onclick={() => removeCustomRateLimit(path)} class="text-red-500 hover:text-red-700 transition-colors" title="删除规则">
                          <Trash2 size={16} />
                        </button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {:else}
            <div class="px-4 py-8 text-center border rounded-lg border-dashed bg-muted/10 text-muted-foreground text-sm">
              暂未配置任何自定义限流规则。
            </div>
          {/if}

          <!-- Add New Limit Form -->
          <div class="flex items-end gap-3 mt-4 pt-4 border-t border-border/50">
            <div class="flex-1 space-y-1">
              <span class="block text-xs font-semibold text-muted-foreground">匹配路径</span>
              <input type="text" bind:value={newPath} placeholder="/rest/v1/payments" class="w-full px-3 py-2 text-sm rounded border bg-background" />
            </div>
            <div class="w-24 space-y-1">
              <span class="block text-xs font-semibold text-muted-foreground">次 / 秒</span>
              <input type="number" bind:value={newSecond} placeholder="10" class="w-full px-3 py-2 text-sm rounded border bg-background" />
            </div>
            <div class="w-24 space-y-1">
              <span class="block text-xs font-semibold text-muted-foreground">次 / 分钟</span>
              <input type="number" bind:value={newMinute} placeholder="100" class="w-full px-3 py-2 text-sm rounded border bg-background" />
            </div>
            <div class="w-24 space-y-1">
              <span class="block text-xs font-semibold text-muted-foreground">次 / 小时</span>
              <input type="number" bind:value={newHour} placeholder="1000" class="w-full px-3 py-2 text-sm rounded border bg-background" />
            </div>
            <button
              onclick={addCustomRateLimit}
              disabled={isSubmittingLimit}
              class="px-4 py-2 bg-brand text-white rounded hover:bg-brand/90 transition-colors font-medium text-sm flex items-center justify-center gap-2 h-[38px]"
            >
              {#if isSubmittingLimit}
                <Loader2 size={16} class="animate-spin" />
              {:else}
                <Plus size={16} /> 新增
              {/if}
            </button>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>
