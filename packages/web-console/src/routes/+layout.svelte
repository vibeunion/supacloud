<script module>
  if (typeof window !== "undefined") {
    if (window.location.hash.includes("/login")) {
      window.location.replace("/login");
    }
  }
</script>

<script lang="ts">
  import "../app.css";
  import "$lib/i18n"; // Ensure svelte-i18n is initialized synchronously before child components import `t`
  import { onMount, type Snippet } from "svelte";
  import {
    setDataProvider,
    setAuthProvider,
    setResources,
    setRouterProvider,
    setTheme,
    setLocale
  } from "@svadmin/core";
  import { createSvelteKitRouterProvider } from "@svadmin/sveltekit";
  import { Layout, Toast, DevTools, setComponentRegistry } from "@svadmin/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { page } from "$app/stores";
  
  import { dataProvider } from "$lib/admin/provider";
  import { authProvider } from "$lib/admin/auth";
  import { resources, getTenantResources } from "$lib/admin/resources";
  
  // Fix 0.18.0 standalone Layout crash: initialize empty registry context so `registry.Breadcrumbs` doesn't throw
  setComponentRegistry({} as any);
  
  let { children }: { children: Snippet } = $props();

  const routerProvider = createSvelteKitRouterProvider();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } }
  });

  // INITIALIZE SYNCHRONOUSLY to prevent <Layout> from crashing because getAuthProvider() was uninitialized during its script execution!
  setDataProvider(dataProvider);
  setAuthProvider(authProvider);

  const ref = $page.params.ref;
  const allResources = ref ? [...resources, ...getTenantResources(ref)] : resources;
  setResources(allResources);

  setRouterProvider(routerProvider);
  setTheme("system");
  setLocale("zh-CN");

  let isRawPage = $derived(($page.url.pathname as string) === "/login" || ($page.url.pathname as string) === "/register");
</script>

<QueryClientProvider client={queryClient}>
  {#if isRawPage}
    {@render children()}
  {:else}
    <Layout title="SupaCloud">
      {@render children()}
    </Layout>
  {/if}
  
  <Toast />
  <DevTools />
</QueryClientProvider>
