<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import Providers from "./providers/+page.svelte";
  import Protection from "./protection/+page.svelte";
  import Templates from "./templates/+page.svelte";
  import RateLimits from "./rate-limits/+page.svelte";

  let { view }: { view: "providers" | "protection" | "templates" | "rate-limits" } = $props();
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false, gcTime: 0 },
    },
  });
</script>

<QueryClientProvider client={client}>
  {#if view === "providers"}
    <Providers />
  {:else if view === "protection"}
    <Protection />
  {:else if view === "rate-limits"}
    <RateLimits />
  {:else}
    <Templates />
  {/if}
</QueryClientProvider>
