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
  import { onMount, type Snippet, untrack } from "svelte";
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
    setLocale,
    setChatProvider,
    addTranslations
  } from "@svadmin/core";
  import { createSvelteKitRouterProvider } from "@svadmin/sveltekit";
  import { Toast as SvadminToast, DevTools, setComponentRegistry, ChatDialog } from "@svadmin/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { dataProvider, chatProvider } from "$lib/admin/provider";
  import { authProvider } from "$lib/admin/auth";
  import { resources as defaultResources, getTenantResources } from "$lib/admin/resources";
  
  import zhLocales from "$lib/i18n/locales/zh.json";
  import enLocales from "$lib/i18n/locales/en.json";
  
  const flattenChat = (loc: any): Record<string, string> => {
    if (!loc?.chat) return {};
    return {
      'chat.title': loc.chat.title || '',
      'chat.welcome': loc.chat.welcome || '',
      'chat.welcomeDesc': loc.chat.welcomeDesc || '',
      'chat.suggestion1': loc.chat.suggestion1 || '',
      'chat.suggestion2': loc.chat.suggestion2 || '',
      'chat.suggestion3': loc.chat.suggestion3 || '',
      'chat.placeholder': loc.chat.placeholder || '',
      'chat.shortcutHint': loc.chat.shortcutHint || '',
    };
  };
  
  addTranslations('zh-CN', flattenChat(zhLocales));
  addTranslations('en', flattenChat(enLocales));


  let { children }: { children: Snippet } = $props();

  // Internal Data
  let projects = $state<Record<string, unknown>[]>([]);
  let projectsLoading = $state(true);
  let isAuthenticated = $state(false);
  let i18nLoadGuardExpired = $state(false);
  
  let isCoreLoading = $derived(projectsLoading || ($isLoading && !i18nLoadGuardExpired));

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
  setChatProvider(chatProvider);
  setTheme("system");
  setLocale("zh-CN");
  
  let lastResourcesKey = $state("");

  // Keep SVAdmin resources in sync with the current tenant route without mutating
  // global provider state from inside a derived computation.
  $effect(() => {
    const freshResources = refFromUrl
      ? [...defaultResources, ...getTenantResources(refFromUrl)]
      : defaultResources;
    const nextKey = freshResources.map((resource) => resource.identifier ?? resource.name).join("|");

    if (nextKey === lastResourcesKey) {
      return;
    }

    lastResourcesKey = nextKey;
    untrack(() => {
      setResources(freshResources);
    });
  });

  onMount(async () => {
    const guardTimer = setTimeout(() => {
      i18nLoadGuardExpired = true;
    }, 4000);

    // Skip auth check on raw pages (login/register)
    if (isRawPage) {
      projectsLoading = false;
      clearTimeout(guardTimer);
      return;
    }

    const token = localStorage.getItem("supacloud_session");
    if (!token) {
      projectsLoading = false;
      window.location.href = "/login";
      clearTimeout(guardTimer);
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
        clearTimeout(guardTimer);
        return;
      }
    } catch {
      projectsLoading = false;
      window.location.href = "/login";
      clearTimeout(guardTimer);
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
      clearTimeout(guardTimer);
    }

    if (!projectsLoading && !projects.length && window.location.pathname.includes('/project/')) {
       goto('/');
    }
  });
</script>

<ModeWatcher defaultMode="light" />
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
      
      <main class="flex-1 overflow-y-auto relative bg-muted/30">
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

        <div class="p-4 sm:p-6">
          {#key currentProject?.ref}
            <div class="svadmin-container">
              {@render children()}
            </div>
          {/key}
        </div>
      </main>
    {/if}
  </div>

  <SvadminToast />
  <ChatDialog />
  <DevTools />
</QueryClientProvider>
