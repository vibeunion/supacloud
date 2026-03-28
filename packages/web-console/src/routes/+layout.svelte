<script lang="ts">
  import "../app.css";
  import { onMount, type Snippet } from "svelte";
  import {
    setDataProvider,
    setAuthProvider,
    setResources,
    setRouterProvider,
    setTheme
  } from "@svadmin/core";
  import { createSvelteKitRouterProvider } from "@svadmin/sveltekit";
  import { Layout, Toast, DevTools } from "@svadmin/ui";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { page } from "$app/stores";
  
  import { dataProvider } from "$lib/admin/provider";
  import { authProvider } from "$lib/admin/auth";
  import { resources, getTenantResources } from "$lib/admin/resources";
  
  let { children }: { children: Snippet } = $props();

  const routerProvider = createSvelteKitRouterProvider();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } }
  });

  $effect.pre(() => {
    setDataProvider(dataProvider);
    setAuthProvider(authProvider);

    const ref = $page.params.ref;
    const allResources = ref ? [...resources, ...getTenantResources(ref)] : resources;
    setResources(allResources);

    setRouterProvider(routerProvider);
    setTheme("system");
  });

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
