<script lang="ts">
  import { apiClient } from "$lib/api";

  import "../app.css";
  import { waitLocale } from "$lib/i18n";
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { isLoading, t } from 'svelte-i18n';
  import Sidebar from "$lib/components/Sidebar.svelte";
  import PlatformSidebar from "$lib/components/PlatformSidebar.svelte";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster, toast } from "svelte-sonner";
  
  let { children } = $props();
  
  let projects = $state<Record<string, unknown>[]>([]);
  let projectsLoading = $state(true);
  let isAuthenticated = $state(false);
  let isOnLoginPage = $state(false);
  
  let isCoreLoading = $derived($isLoading || projectsLoading);

  // Derive currentProject from URL's [ref] param, fallback to first project
  let currentProject = $derived.by(() => {
    const refFromUrl = $page.params?.ref;
    if (refFromUrl && projects.length) {
      return projects.find(p => p.ref === refFromUrl) || projects[0];
    }
    return projects[0] || null;
  });

  let isPlatformRoute = $derived($page.url.pathname.startsWith("/platform"));

  onMount(async () => {
    await waitLocale();

    // Skip auth check on login page
    if (window.location.pathname === "/login") {
      isOnLoginPage = true;
      projectsLoading = false;
      return;
    }

    // Check session
    const token = localStorage.getItem("supacloud_session");
    if (!token) {
      projectsLoading = false;
      goto("/login");
      return;
    }

    // Verify token validity
    try {
      const res = await apiClient("/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      });
      const data = await res.json();
      if (!data.valid) {
        localStorage.removeItem("supacloud_session");
        localStorage.removeItem("supacloud_master_token");
        projectsLoading = false;
        goto("/login");
        return;
      }
    } catch {
      projectsLoading = false;
      goto("/login");
      return;
    }

    isAuthenticated = true;

    // Fetch projects
    try {
      const response = await apiClient('/v1/projects');
      if (response.ok) {
        projects = await response.json();
      }
    } catch (err: unknown) {
      toast.error("网络错误 during project loading");
    } finally {
      projectsLoading = false;
    }

    if (!projectsLoading && !projects.length && window.location.pathname.includes('/project/')) {
       goto('/');
    }
  });
</script>

<ModeWatcher />
<Toaster richColors position="top-right" />

<div class="flex h-screen overflow-hidden bg-background">
  {#if isOnLoginPage}
    {@render children()}
  {:else if isCoreLoading}
    <div class="flex-1 flex flex-col items-center justify-center space-y-4">
      <div class="w-12 h-12 border-4 border-brand border-t-transparent rounded-full animate-spin"></div>
      <p class="text-muted-foreground animate-pulse text-sm">Initializing Studio Core...</p>
    </div>
  {:else if !isAuthenticated}
    <div class="flex-1 flex flex-col items-center justify-center space-y-4">
      <p class="text-muted-foreground text-sm">正在跳转到登录页面…</p>
    </div>
  {:else}
    {#if isPlatformRoute}
      <PlatformSidebar />
    {:else}
      <Sidebar {projects} {currentProject} />
    {/if}
    
    <main class="flex-1 overflow-y-auto relative">
      <div class="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b bg-background px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
        <div class="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <span class="hover:text-foreground cursor-pointer transition-colors">Default Organization</span>
            <span>/</span>
            <span class="text-foreground font-medium">{isPlatformRoute ? 'Platform Admin' : (currentProject?.name || 'Home')}</span>
          </div>
        </div>
        <button
          onclick={() => { localStorage.removeItem('supacloud_session'); localStorage.removeItem('supacloud_master_token'); window.location.href = '/login'; }}
          class="px-3 py-1.5 text-xs font-medium rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
        >
          {$t("Auth.signOut") || "Logout"}
        </button>
      </div>

      <div class="py-10">
        <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {@render children()}
        </div>
      </div>
    </main>
  {/if}
</div>
