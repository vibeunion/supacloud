<script lang="ts">
  import { apiClient } from "$lib/api";

  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Loader2, Rocket, FolderGit2, Upload, AlertTriangle } from "lucide-svelte";

  const projectRef = $derived(page.params.ref ?? "");

  const FRAMEWORKS = [
    { id: "static", label: "静态站点", desc: "纯 HTML/CSS/JS", ssr: false },
    { id: "react", label: "React (Vite)", desc: "npm run build → dist", ssr: false },
    { id: "vue", label: "Vue (Vite)", desc: "npm run build → dist", ssr: false },
    { id: "svelte", label: "Svelte (Vite)", desc: "npm run build → dist", ssr: false },
    { id: "nextjs", label: "Next.js", desc: "SSR/SSG/ISR", ssr: true },
    { id: "nuxt", label: "Nuxt", desc: "SSR · npm run build → .output", ssr: true },
    { id: "sveltekit", label: "SvelteKit SSR", desc: "adapter-node → build", ssr: true },
    { id: "sveltekit-static", label: "SvelteKit Static", desc: "adapter-static → build", ssr: false },
    { id: "astro", label: "Astro", desc: "SSG/SSR · npm run build → dist", ssr: false },
    { id: "remix", label: "Remix", desc: "SSR · npm run build → build", ssr: true },
  ];

  let name = $state("");
  let framework = $state("static");
  let gitUrl = $state("");
  let gitBranch = $state("main");
  let buildCommand = $state("");
  let outputDir = $state("");
  let installCommand = $state("");
  let healthCheckPath = $state("/");
  let deployMode = $state<"git" | "upload">("git");
  let isCreating = $state(false);
  let error: string | null = $state.raw(null);

  const selectedFw = $derived(FRAMEWORKS.find(f => f.id === framework));

  async function createDeploy() {
    if (!name.trim()) { error = "请输入站点名称"; return; }
    isCreating = true;
    error = null;

    try {
      const res = await apiClient(`/v1/projects/${projectRef}/frontend/deployments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          framework,
          build_command: buildCommand || undefined,
          output_dir: outputDir || undefined,
          install_command: installCommand || undefined,
          health_check_path: selectedFw?.ssr ? healthCheckPath || "/" : undefined,
        })
      });
      const dep = await res.json();
      if (!res.ok) { error = dep.error || "创建失败"; isCreating = false; return; }

      if (deployMode === "git" && gitUrl.trim()) {
        await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${dep.id}/git`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ git_url: gitUrl.trim(), branch: gitBranch || "main" })
        });

        await apiClient(`/v1/projects/${projectRef}/frontend/deployments/${dep.id}/deploy/git`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ git_url: gitUrl.trim(), branch: gitBranch || "main" })
        });
      }

      goto(resolve("/project/[ref]/hosting", { ref: projectRef }));
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      isCreating = false;
    }
  }
</script>

<div class="max-w-2xl mx-auto space-y-6">
  <div>
    <h2 class="text-xl font-bold">新建部署</h2>
    <p class="text-xs text-muted-foreground mt-1">创建一个新的前端站点部署</p>
  </div>

  {#if error}
    <div class="rounded-lg border px-4 py-3 text-xs font-medium bg-red-500/10 border-red-500/20 text-red-700 flex items-center gap-2">
      <AlertTriangle size={14} /> {error}
    </div>
  {/if}

  <!-- Site Name -->
  <div class="rounded-xl border bg-card p-5">
    <label for="site-name" class="text-sm font-semibold block mb-2">站点名称</label>
    <input id="site-name" bind:value={name} placeholder="my-awesome-site" class="w-full px-3 py-2 text-sm rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand font-mono" />
  </div>

  <!-- Framework Select -->
  <div class="rounded-xl border bg-card p-5">
    <h3 class="text-sm font-semibold mb-3">选择框架</h3>
    <div class="grid grid-cols-3 gap-2">
      {#each FRAMEWORKS as fw (fw.id)}
        <button
          onclick={() => framework = fw.id}
          class="flex flex-col items-start p-3 rounded-lg border transition-all text-left {framework === fw.id ? 'border-brand bg-brand/5 ring-1 ring-brand' : 'hover:border-brand/30 hover:bg-muted/30'}"
        >
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold">{fw.label}</span>
            {#if fw.ssr}<span class="px-1 py-0.5 rounded text-[8px] font-bold bg-purple-500/10 text-purple-600">SSR</span>{/if}
          </div>
          <span class="text-[10px] text-muted-foreground mt-0.5">{fw.desc}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Deploy Mode -->
  <div class="rounded-xl border bg-card p-5">
    <h3 class="text-sm font-semibold mb-3">部署方式</h3>
    <div class="flex gap-2 mb-4">
      <button onclick={() => deployMode = 'git'} class="flex-1 flex items-center gap-2 p-3 rounded-lg border transition-all {deployMode === 'git' ? 'border-brand bg-brand/5' : 'hover:border-brand/30'}">
        <FolderGit2 size={16} /> <span class="text-xs font-semibold">Git 仓库</span>
      </button>
      <button onclick={() => deployMode = 'upload'} class="flex-1 flex items-center gap-2 p-3 rounded-lg border transition-all {deployMode === 'upload' ? 'border-brand bg-brand/5' : 'hover:border-brand/30'}">
        <Upload size={16} /> <span class="text-xs font-semibold">直接上传</span>
      </button>
    </div>

    {#if deployMode === 'git'}
      <div class="space-y-3">
        <div>
          <label for="git-url" class="text-xs font-semibold text-muted-foreground block mb-1">Git 仓库 URL</label>
          <input id="git-url" bind:value={gitUrl} placeholder="https://github.com/user/repo.git" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
          <p class="text-[10px] text-muted-foreground mt-1">支持 GitHub、GitLab、Gitee、GitCode 等任何 Git 仓库</p>
        </div>
        <div>
          <label for="git-branch" class="text-xs font-semibold text-muted-foreground block mb-1">分支</label>
          <input id="git-branch" bind:value={gitBranch} placeholder="main" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
        </div>
      </div>
    {:else}
      <div class="text-center py-4">
        <p class="text-xs text-muted-foreground">创建部署后，可在站点设置中上传 ZIP 文件进行部署</p>
      </div>
    {/if}
  </div>

  <!-- Build Settings (optional override) -->
  <details class="rounded-xl border bg-card overflow-hidden">
    <summary class="px-5 py-3 text-sm font-semibold cursor-pointer hover:bg-muted/20">高级构建设置（可选）</summary>
    <div class="px-5 pb-5 space-y-3 border-t pt-4">
      <p class="text-[10px] text-muted-foreground">留空将使用所选框架的默认配置</p>
      <div>
        <label for="build-cmd" class="text-xs font-semibold text-muted-foreground block mb-1">构建命令</label>
        <input id="build-cmd" bind:value={buildCommand} placeholder={selectedFw?.id === 'static' ? '无需构建' : 'npm run build'} class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
      <div>
        <label for="out-dir" class="text-xs font-semibold text-muted-foreground block mb-1">输出目录</label>
        <input id="out-dir" bind:value={outputDir} placeholder="dist" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
      <div>
        <label for="install-cmd" class="text-xs font-semibold text-muted-foreground block mb-1">安装命令</label>
        <input id="install-cmd" bind:value={installCommand} placeholder="npm install" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
      </div>
      {#if selectedFw?.ssr}
        <div>
          <label for="health-check-path" class="text-xs font-semibold text-muted-foreground block mb-1">健康检查路径</label>
          <input id="health-check-path" bind:value={healthCheckPath} placeholder="/" class="w-full px-3 py-2 text-xs font-mono rounded-md border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-brand" />
          <p class="text-[10px] text-muted-foreground mt-1">收到任意非 5xx HTTP 响应即视为就绪</p>
        </div>
      {/if}
    </div>
  </details>

  <!-- Submit -->
  <button onclick={createDeploy} disabled={isCreating || !name.trim()} class="w-full px-4 py-3 text-sm font-semibold rounded-lg bg-brand text-white hover:bg-brand/90 transition-colors flex items-center justify-center gap-2 disabled:opacity-50">
    {#if isCreating}<Loader2 size={16} class="animate-spin" />{:else}<Rocket size={16} />{/if}
    创建并部署
  </button>
</div>
