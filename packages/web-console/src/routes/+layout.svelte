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
  import { resources } from "$lib/admin/resources";
  
  // This initializes the internal svadmin router state
  // We need to import it using the exact path since it's not exported in index.ts
  // @ts-ignore
  import { initRouter } from "@svadmin/ui/router-state.svelte.js";

  let { children }: { children: Snippet } = $props();

  const routerProvider = createSvelteKitRouterProvider();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } }
  });

  $effect.pre(() => {
    setDataProvider(dataProvider);
    setAuthProvider(authProvider);
    setResources(resources);
    setRouterProvider(routerProvider);
    setTheme("system");
    initRouter(routerProvider);
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
