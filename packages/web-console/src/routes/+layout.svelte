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
  import { onMount, tick, type Snippet } from "svelte";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/stores";
  import { isLoading, t, waitLocale, locale } from 'svelte-i18n';
  import Sidebar from "$lib/components/Sidebar.svelte";
  import PlatformSidebar from "$lib/components/PlatformSidebar.svelte";
  import { ModeWatcher } from "mode-watcher";
  import { toast } from "svelte-sonner";
  
  // SVAdmin Providers
  import {
    addTranslations,
    createProviderBundle,
    provideAdminContext,
    setLocale,
    setTheme,
  } from "@svadmin/core";
  import { createSvelteKitRouterProvider } from "@svadmin/sveltekit";
  import {
    Button,
    ChatDialog,
    DevTools,
    Header,
    PageSkeleton,
    Toast as SvadminToast,
  } from "@svadmin/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { Menu, Plug, X } from "lucide-svelte";
  import { dataProvider, chatProvider } from "$lib/admin/provider";
  import { authProvider } from "$lib/admin/auth";
  import { buildResourceRegistry, type ResourceLabels } from "$lib/admin/resources";
  import { resolveAdminTenant } from "$lib/admin/tenant";
  
  import zhLocales from "$lib/i18n/locales/zh.json";
  import enLocales from "$lib/i18n/locales/en.json";
  
  const flattenChat = (locales: unknown): Record<string, string> => {
    if (!locales || typeof locales !== "object") return {};
    const chat = (locales as Record<string, unknown>).chat;
    if (!chat || typeof chat !== "object") return {};
    const value = (key: string) => {
      const candidate = (chat as Record<string, unknown>)[key];
      return typeof candidate === "string" ? candidate : "";
    };
    return {
      "chat.title": value("title"),
      "chat.welcome": value("welcome"),
      "chat.welcomeDesc": value("welcomeDesc"),
      "chat.suggestion1": value("suggestion1"),
      "chat.suggestion2": value("suggestion2"),
      "chat.suggestion3": value("suggestion3"),
      "chat.placeholder": value("placeholder"),
      "chat.shortcutHint": value("shortcutHint"),
    };
  };
  
  addTranslations('zh-CN', flattenChat(zhLocales));
  addTranslations('en', flattenChat(enLocales));


  let { children }: { children: Snippet } = $props();

  // Internal Data
  interface ProjectSummary extends Record<string, unknown> {
    ref: string;
    name?: string;
  }

  function isProjectSummary(value: unknown): value is ProjectSummary {
    return Boolean(
      value
      && typeof value === "object"
      && typeof (value as Record<string, unknown>).ref === "string"
      && (value as Record<string, unknown>).ref,
    );
  }

  let projects = $state<ProjectSummary[]>([]);
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

  let refFromUrl = $derived(typeof $page.params.ref === "string" ? $page.params.ref : null);

  let currentProject = $derived.by(() => {
    if (refFromUrl) return projects.find((project) => project.ref === refFromUrl) ?? null;
    return projects[0] ?? null;
  });

  // SVAdmin Initialization
  const routerProvider = createSvelteKitRouterProvider();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } }
  });

  setTheme("system");
  const readLocale = () => {
    if (typeof localStorage === "undefined") return "zh-CN";
    return localStorage.getItem("selected-locale") || "zh-CN";
  };

  const mapToSvadminLocale = (value: string | null | undefined) => {
    const normalized = value?.toLowerCase() ?? "zh-cn";
    return normalized.startsWith("zh") ? "zh-CN" : "en";
  };

  const getResourceLabels = (): ResourceLabels => ({
    projects: $t("ProjectSettings.resource_projects"),
    referenceId: $t("ProjectSettings.reference_id"),
    projectName: $t("Settings.project_name"),
    status: $t("Settings.status"),
    active: $t("ProjectSettings.status_active"),
    paused: $t("ProjectSettings.status_paused"),
    creating: $t("ProjectSettings.status_creating"),
    region: $t("Settings.region"),
    localDocker: $t("ProjectSettings.local_docker"),
    databaseHost: $t("ProjectSettings.database_host"),
    databasePort: $t("ProjectSettings.database_port"),
    tables: $t("Tables.resource_label"),
    tableName: $t("Tables.name"),
    schema: $t("Tables.schema"),
    type: $t("Tables.type"),
    rows: $t("Tables.rows"),
  });

  const projectRefs = $derived(projects.map((project) => project.ref));
  const adminResources = $derived(buildResourceRegistry(projectRefs, getResourceLabels()));
  const adminTenant = $derived(resolveAdminTenant({
    projectRefs,
    projectRef: refFromUrl,
    isRawPage,
    isPlatformRoute,
  }));
  const providerBundle = createProviderBundle({
    dataProvider,
    authProvider,
    routerProvider,
    chatProvider,
  });

  provideAdminContext({
    get providerBundle() { return providerBundle; },
    get resources() { return adminResources; },
    get tenant() { return adminTenant; },
  });

  setLocale(mapToSvadminLocale(readLocale()));

  async function handleLogout() {
    try {
      const result = await logoutStudio();
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      window.location.href = "/login";
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
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
          const payload: unknown = await response.json();
          projects = Array.isArray(payload) ? payload.filter(isProjectSummary) : [];
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

<QueryClientProvider client={queryClient}>
  <div class={isRawPage ? "flex min-h-screen bg-background" : "flex h-screen overflow-hidden bg-background"}>
    {#if isRawPage}
      <div class="min-h-screen flex-1 w-full relative">
        {@render children()}
      </div>
    {:else if isCoreLoading}
      <main class="flex-1 overflow-y-auto bg-muted/30 p-4 sm:p-6">
        <PageSkeleton type="list" rows={5} />
      </main>
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
        <Header showBreadcrumbs={false} showSearch={false}>
          {#snippet children()}
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
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <span class="hover:text-foreground cursor-pointer transition-colors">{$t("Dashboard.org_default") || "Default Organization"}</span>
            <span>/</span>
            <span class="text-foreground font-medium">{isPlatformRoute ? ($t("Sidebar.platform_admin") || "Platform Admin") : (currentProject?.name || ($t("Project.home") || "Home"))}</span>
          </div>
          {/snippet}
          {#snippet rightActions()}
          {#if !isPlatformRoute && currentProject?.ref}
            <Button
              href={resolve("/project/[ref]/api", { ref: currentProject.ref })}
              variant="outline"
              size="sm"
              class="border-brand/20 text-brand hover:border-brand/40 hover:bg-brand/5"
            >
              <Plug data-icon="inline-start" />
              <span class="hidden sm:inline">{$t("Navigation.connect_api")}</span>
            </Button>
          {/if}
          <Button
            variant="ghost"
            size="sm"
            onclick={handleLogout}
          >
            {$t("Auth.signOut") || "Logout"}
          </Button>
          {/snippet}
        </Header>

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
  {#if !isRawPage}
    <ChatDialog />
    <DevTools />
  {/if}
</QueryClientProvider>
