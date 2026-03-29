<script module>
  if (typeof window !== "undefined") {
    if (window.location.hash.includes("/login")) {
      window.location.replace("/login");
    }
  }
</script>

<script lang="ts">
  import { apiClient } from "$lib/api";

  import "../app.css";
  import "$lib/i18n"; // Ensure svelte-i18n is initialized synchronously
  import { onMount, type Snippet } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/stores";
  import { isLoading, t } from 'svelte-i18n';
  import Sidebar from "$lib/components/Sidebar.svelte";
  import PlatformSidebar from "$lib/components/PlatformSidebar.svelte";
  import { ModeWatcher } from "mode-watcher";
  import { Toaster, toast } from "svelte-sonner";
  
  // SVAdmin Providers
  import {
    setDataProvider,
    setAuthProvider,
    setResources,
    setRouterProvider,
    setTheme,
    setLocale
  } from "@svadmin/core";
  import { createSvelteKitRouterProvider } from "@svadmin/sveltekit";
  import { Toast as SvadminToast, DevTools, setComponentRegistry } from "@svadmin/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { dataProvider } from "$lib/admin/provider";
  import { authProvider } from "$lib/admin/auth";
  import { resources as defaultResources, getTenantResources } from "$lib/admin/resources";

  let { children }: { children: Snippet } = $props();

  // Internal Data
  let projects = $state<Record<string, unknown>[]>([]);
  let projectsLoading = $state(true);
  let isAuthenticated = $state(false);
  
  let isCoreLoading = $derived($isLoading || projectsLoading);

  // Route Detection
  let isRawPage = $derived(($page.url.pathname as string) === "/login" || ($page.url.pathname as string) === "/register");
  let isPlatformRoute = $derived($page.url.pathname.startsWith("/platform"));

  let refFromUrl = $derived.by(() => {
    const match = $page.url.pathname.match(/^\/project\/([^/]+)/);
    return match ? match[1] : null;
  });

  let currentProject = $derived.by(() => {
    if (refFromUrl && projects.length) {
      return projects.find(p => p.ref === refFromUrl) || projects[0];
    }
    return projects[0] || null;
  });

  // SVAdmin Initialization
  const routerProvider = createSvelteKitRouterProvider();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } }
  });

  setComponentRegistry({} as any);
  setDataProvider(dataProvider);
  setAuthProvider(authProvider);
  setRouterProvider(routerProvider);
  setTheme("system");
  setLocale("zh-CN");
  
  // Provide base resources synchronously, then update via effect when refFromUrl changes
  setResources(defaultResources);
  $effect(() => {
    const freshResources = refFromUrl ? [...defaultResources, ...getTenantResources(refFromUrl)] : defaultResources;
    setResources(freshResources);
  });

  onMount(async () => {
    // Skip auth check on raw pages (login/register)
    if (isRawPage) {
      projectsLoading = false;
      return;
    }

    const token = localStorage.getItem("supacloud_session");
    if (!token) {
      projectsLoading = false;
      window.location.href = "/login";
      return;
    }

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
        window.location.href = "/login";
        return;
      }
    } catch {
      projectsLoading = false;
      window.location.href = "/login";
      return;
    }

    isAuthenticated = true;

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
<!-- Alias Toaster as SonnerToaster in script but use the original name in markup if not aliased -->
<Toaster richColors position="top-right" />

<QueryClientProvider client={queryClient}>
  <div class="flex h-screen overflow-hidden bg-background">
    {#if isRawPage}
      <div class="flex-1 w-full relative">
        {@render children()}
      </div>
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
            {#key currentProject?.ref}
              <div class="svadmin-container">
                {@render children()}
              </div>
            {/key}
          </div>
        </div>
      </main>
    {/if}
  </div>

  <SvadminToast />
  <DevTools />
</QueryClientProvider>
