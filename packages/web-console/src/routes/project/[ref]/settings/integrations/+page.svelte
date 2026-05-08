<script lang="ts">
  import { page } from "$app/state";
  import { ExternalLink, Globe, Webhook, Puzzle, ToggleRight } from "lucide-svelte";

  interface Integration {
    id: string;
    name: string;
    description: string;
    icon: string;
    category: string;
    enabled: boolean;
    docsUrl: string;
  }

  const projectRef = $derived(page.params.ref);

  let toastMsg = $state<string | null>(null);

  let integrations: Integration[] = $state([
    { id: "github", name: "GitHub", description: "连接 GitHub 仓库，实现代码推送时自动部署前端应用", icon: "🐙", category: "版本控制", enabled: false, docsUrl: "https://docs.github.com/webhooks" },
    { id: "vercel", name: "Vercel", description: "与 Vercel 深度集成，自动同步环境变量和数据库连接", icon: "▲", category: "托管平台", enabled: false, docsUrl: "https://vercel.com/integrations" },
    { id: "netlify", name: "Netlify", description: "通过 Netlify 部署静态站点，自动注入 Supabase 连接信息", icon: "🌐", category: "托管平台", enabled: false, docsUrl: "https://docs.netlify.com" },
    { id: "stripe", name: "Stripe", description: "集成 Stripe 支付事件，通过 Webhook 自动同步到数据库", icon: "💳", category: "支付", enabled: false, docsUrl: "https://stripe.com/docs/webhooks" },
    { id: "auth0", name: "Auth0", description: "使用 Auth0 作为外部认证提供者，通过 JWT 进行联合认证", icon: "🔐", category: "认证", enabled: false, docsUrl: "https://auth0.com/docs" },
    { id: "cloudflare", name: "Cloudflare", description: "在 Cloudflare Workers 中使用 Supabase，自带连接池优化", icon: "☁️", category: "CDN/边缘", enabled: false, docsUrl: "https://developers.cloudflare.com" },
    { id: "prisma", name: "Prisma", description: "使用 Prisma ORM 连接你的 Supabase PostgreSQL 数据库", icon: "🔷", category: "ORM", enabled: false, docsUrl: "https://www.prisma.io/docs" },
    { id: "drizzle", name: "Drizzle ORM", description: "轻量级 TypeScript ORM，原生支持 Supabase PostgreSQL", icon: "💧", category: "ORM", enabled: false, docsUrl: "https://orm.drizzle.team" },
  ]);

  const categories = $derived([...new Set(integrations.map(i => i.category))]);
</script>

<div class="h-full flex flex-col space-y-4">
  <div>
    <h1 class="text-2xl font-bold">外部集成</h1>
    <p class="text-sm text-muted-foreground mt-1">连接第三方服务和工具，扩展你的项目能力</p>
  </div>

  <div class="rounded-lg border bg-blue-500/5 border-blue-500/20 p-3 flex items-start gap-2">
    <Puzzle size={14} class="text-blue-600 mt-0.5 shrink-0" />
    <p class="text-xs text-blue-700">集成功能允许你将 SupaCloud 项目与外部服务连接起来。已启用的集成已在你的项目中配置完毕，你可以随时启用或禁用。</p>
  </div>

  {#if toastMsg}
    <div class="rounded-lg border bg-brand/10 border-brand/20 text-brand px-4 py-3 text-xs font-medium flex items-center justify-between">
      {toastMsg}
      <button onclick={() => toastMsg = null} class="p-1 hover:bg-brand/20 rounded-md">关闭</button>
    </div>
  {/if}

  {#each categories as cat}
    <div>
      <h2 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">{cat}</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        {#each integrations.filter(i => i.category === cat) as integration}
          <div class="rounded-xl border bg-card hover:border-brand/30 transition-colors overflow-hidden">
            <div class="p-5 flex items-start justify-between">
              <div class="flex items-start gap-3">
                <div class="w-10 h-10 rounded-lg bg-muted/50 flex items-center justify-center text-lg shrink-0">
                  {integration.icon}
                </div>
                <div>
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-sm">{integration.name}</span>
                    {#if integration.enabled}
                      <span class="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-green-500/10 text-green-600">已启用</span>
                    {/if}
                  </div>
                  <p class="text-[10px] text-muted-foreground mt-1 leading-relaxed">{integration.description}</p>
                </div>
              </div>
            </div>
            <div class="border-t px-5 py-2.5 bg-muted/10 flex items-center justify-between">
              <a href={integration.docsUrl} target="_blank" rel="noopener noreferrer"
                class="text-[10px] text-brand flex items-center gap-1 hover:underline">
                <ExternalLink size={10} /> 查看文档
              </a>
              {#if !integration.enabled}
                <button 
                  onclick={() => {
                    toastMsg = `【${integration.name}】集成配置向导正在开发中，敬请期待！`;
                    setTimeout(() => toastMsg = null, 4000);
                  }}
                  class="px-3 py-1 text-[10px] font-semibold rounded-md border hover:bg-muted/50 transition-colors flex items-center gap-1"
                >
                  <ToggleRight size={12} /> 配置
                </button>
              {:else}
                <button 
                  onclick={() => {
                    integration.enabled = false;
                    toastMsg = `已断开与 ${integration.name} 的集成。`;
                    setTimeout(() => toastMsg = null, 4000);
                  }}
                  class="px-3 py-1 text-[10px] font-semibold rounded-md border border-red-500/20 text-red-600 hover:bg-red-500/10 transition-colors flex items-center gap-1"
                >
                  停用
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/each}
</div>
