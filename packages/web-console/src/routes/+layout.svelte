<script module>
  import "$lib/i18n";

  if (typeof window !== "undefined") {
    if (window.location.hash.includes("/login")) {
      window.location.replace("/login");
    }
  }
</script>

<script lang="ts">
  import { apiClient, getStudioSession, logoutStudio } from "$lib/api";

  import "../app.css";
  import "$lib/i18n";
  import { onMount, tick, type Snippet, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/stores";
  import { isLoading, t, waitLocale, locale } from 'svelte-i18n';
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
  import { Menu, Plug, X } from "lucide-svelte";
  import { dataProvider, chatProvider } from "$lib/admin/provider";
  import { authProvider } from "$lib/admin/auth";
  import { buildResourceRegistry } from "$lib/admin/resources";
  
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
  let mobileNavOpen = $state(false);
  let mobileNavTrigger = $state<HTMLButtonElement>();
  let mobileNavCloseButton = $state<HTMLButtonElement>();
  let mobileNavDialog = $state<HTMLDivElement>();
  
  let isCoreLoading = $derived(projectsLoading || ($isLoading && !i18nLoadGuardExpired));

  // Route Detection
  let isRawPage = $derived(
    ($page.url.pathname as string) === "/" ||
    ($page.url.pathname as string) === "/login" ||
    ($page.url.pathname as string) === "/register"
  );
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
  const readLocale = () => {
    if (typeof localStorage === "undefined") return "zh-CN";
    return localStorage.getItem("selected-locale") || "zh-CN";
  };

  const mapToSvadminLocale = (value: string) => {
    const normalized = value.toLowerCase();
    return normalized.startsWith("zh") ? "zh-CN" : "en";
  };

  setLocale(mapToSvadminLocale(readLocale()));
  
  let lastResourcesKey = "";

  const getResourceKey = (resources: { identifier?: string; name: string }[]) =>
    resources.map((resource) => resource.identifier ?? resource.name).join("|");

  async function handleLogout() {
    try {
      await logoutStudio();
    } finally {
      window.location.href = "/login";
    }
  }

  async function openMobileNavigation() {
    mobileNavOpen = true;
    await tick();
    mobileNavCloseButton?.focus();
  }

  function closeMobileNavigation(restoreFocus = true) {
    mobileNavOpen = false;
    if (restoreFocus) {
      void tick().then(() => mobileNavTrigger?.focus());
    }
  }

  function handleMobileNavigation(event: MouseEvent) {
    if (event.target instanceof Element && event.target.closest("a")) {
      closeMobileNavigation(false);
    }
  }

  function handleNavigationKeydown(event: KeyboardEvent) {
    if (!mobileNavOpen) return;

    if (event.key === "Escape") {
      event.preventDefault();
      closeMobileNavigation();
      return;
    }

    if (event.key !== "Tab" || !mobileNavDialog) return;

    const focusable = Array.from(
      mobileNavDialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => !element.hasAttribute("hidden"));
    if (!focusable.length) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !mobileNavDialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    const projectRefs = projects
      .map((project) => String((project as Record<string, unknown>).ref ?? ""))
      .filter(Boolean);
    const freshResources = buildResourceRegistry(projectRefs);
    const nextKey = getResourceKey(freshResources);

    if (nextKey === lastResourcesKey) {
      return;
    }

    lastResourcesKey = nextKey;
    untrack(() => {
      setResources(freshResources);
    });
  });

  onMount(() => {
    let guardTimer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeLocale: (() => void) | undefined = locale.subscribe((value) => {
      if (!value) return;
      setLocale(mapToSvadminLocale(value));
    });

    const cleanupLocale = () => {
      unsubscribeLocale?.();
      unsubscribeLocale = undefined;
    };
    const clearGuardTimer = () => {
      if (guardTimer) clearTimeout(guardTimer);
      guardTimer = undefined;
    };

    void (async () => {
      // Wait for i18n to be ready
      try { await waitLocale(); } catch { /* non-critical */ }
      guardTimer = setTimeout(() => {
        i18nLoadGuardExpired = true;
      }, 4000);

      // Skip auth check on raw pages (login/register)
      if (isRawPage) {
        projectsLoading = false;
        clearGuardTimer();
        cleanupLocale();
        return;
      }

      try {
        const session = await getStudioSession();
        if (!session.authenticated) {
          projectsLoading = false;
          window.location.href = "/login";
          clearGuardTimer();
          cleanupLocale();
          return;
        }
      } catch {
        projectsLoading = false;
        window.location.href = "/login";
        clearGuardTimer();
        cleanupLocale();
        return;
      }

      isAuthenticated = true;

      try {
        const response = await apiClient('/v1/projects');
        if (response.ok) {
          const nextProjects = await response.json();
          const projectRefs = nextProjects
            .map((project: Record<string, unknown>) => String(project.ref ?? ""))
            .filter(Boolean);
          const nextResources = buildResourceRegistry(projectRefs);

          projects = nextProjects;
          lastResourcesKey = getResourceKey(nextResources);
          setResources(nextResources);
        }
      } catch (err: unknown) {
        toast.error($t("Common.network_error") || "Network error");
      } finally {
        projectsLoading = false;
        clearGuardTimer();
      }

      if (!projectsLoading && !projects.length && window.location.pathname.includes('/project/')) {
         goto(resolve('/'));
      }
    })();

    return () => {
      clearGuardTimer();
      cleanupLocale();
    };
  });
</script>

<ModeWatcher defaultMode="light" />
<!-- Alias Toaster as SonnerToaster in script but use the original name in markup if not aliased -->
<Toaster richColors position="top-right" />

<QueryClientProvider client={queryClient}>
  <div class={isRawPage ? "flex min-h-screen bg-background" : "flex h-screen overflow-hidden bg-background"}>
    {#if isRawPage}
      <div class="min-h-screen flex-1 w-full relative">
        {@render children()}
      </div>
    {:else if isCoreLoading}
      <div class="flex-1 flex flex-col items-center justify-center space-y-4">
        <div class="w-12 h-12 border-4 border-brand border-t-transparent rounded-full animate-spin"></div>
        <p class="text-muted-foreground animate-pulse text-sm">{$t("Common.loading") || "Loading..."}</p>
      </div>
    {:else if !isAuthenticated}
      <div class="flex-1 flex flex-col items-center justify-center space-y-4">
        <p class="text-muted-foreground text-sm">{$t("Login.redirecting", { default: "Redirecting to login..." })}</p>
      </div>
    {:else}
      {#if isPlatformRoute}
        <PlatformSidebar className="hidden lg:flex" />
      {:else}
        <Sidebar className="hidden lg:flex" {projects} {currentProject} />
      {/if}

      {#if mobileNavOpen}
        <div class="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            class="absolute inset-0 bg-black/50 backdrop-blur-sm"
            aria-label={$t("Sidebar.close_navigation") || "Close navigation"}
            onclick={() => closeMobileNavigation()}
          ></button>
          <div
            id="mobile-navigation"
            bind:this={mobileNavDialog}
            class="relative z-10 w-fit shadow-2xl"
            onclick={handleMobileNavigation}
            onkeydown={handleNavigationKeydown}
            role="dialog"
            aria-modal="true"
            aria-label={$t("Sidebar.open_navigation") || "Navigation"}
            tabindex="-1"
          >
            <button
              bind:this={mobileNavCloseButton}
              type="button"
              class="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-lg border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
              aria-label={$t("Sidebar.close_navigation") || "Close navigation"}
              onclick={() => closeMobileNavigation()}
            >
              <X class="h-4 w-4" />
            </button>
            {#if isPlatformRoute}
              <PlatformSidebar />
            {:else}
              <Sidebar {projects} {currentProject} />
            {/if}
          </div>
        </div>
      {/if}
      
      <main class="flex-1 overflow-y-auto relative bg-muted/30">
        <div class="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b bg-background px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
          <button
            bind:this={mobileNavTrigger}
            type="button"
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
            aria-label={$t("Sidebar.open_navigation") || "Open navigation"}
            aria-controls="mobile-navigation"
            aria-expanded={mobileNavOpen}
            onclick={openMobileNavigation}
          >
            <Menu class="h-5 w-5" />
          </button>
          <div class="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
            <div class="flex items-center gap-2 text-sm text-muted-foreground">
              <span class="hover:text-foreground cursor-pointer transition-colors">{$t("Dashboard.org_default") || "Default Organization"}</span>
              <span>/</span>
              <span class="text-foreground font-medium">{isPlatformRoute ? ($t("Sidebar.platform_admin") || "Platform Admin") : (currentProject?.name || ($t("Project.home") || "Home"))}</span>
            </div>
          </div>
          {#if !isPlatformRoute && currentProject?.ref}
            <a
              href={`/project/${currentProject.ref}/api`}
              class="inline-flex h-9 items-center gap-2 rounded-lg border bg-background px-3 text-xs font-semibold text-foreground transition-colors hover:border-brand/40 hover:bg-brand/5 hover:text-brand"
            >
              <Plug class="h-4 w-4" />
              <span class="hidden sm:inline">{$t("Navigation.connect_api")}</span>
            </a>
          {/if}
          <button
            onclick={handleLogout}
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

  {#if !isRawPage}
    <SvadminToast />
    <ChatDialog />
    <DevTools />
  {/if}
</QueryClientProvider>
