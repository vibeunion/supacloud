<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import Page from "./+page.svelte";
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: 2, retryDelay: 1, gcTime: 0 },
    },
  });
</script>
<QueryClientProvider client={client}><Page /></QueryClientProvider>
