<script lang="ts">
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import Detail from "./+page.svelte";
  import { registerFixtureClient } from "./env.test-fixture.svelte";
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  registerFixtureClient(client);
</script>

<QueryClientProvider client={client}><Detail /></QueryClientProvider>
