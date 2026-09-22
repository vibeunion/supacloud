<script lang="ts">
  import { createProviderBundle, provideAdminContext } from "@svadmin/core";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { untrack } from "svelte";
  import { dataProvider } from "../../../../../../lib/admin/provider";
  import { fixture } from "./rows.test-fixture.svelte";
  import Page from "./+page.svelte";

  let { withTenant = true }: { withTenant?: boolean } = $props();
  const source = { providerBundle: createProviderBundle({ dataProvider }), resources: [] };
  if (untrack(() => withTenant)) {
    provideAdminContext({ ...source, get tenant() { return fixture.tenant; } });
  } else {
    provideAdminContext(source);
  }
  const client = new QueryClient();
</script>

<QueryClientProvider client={client}><Page /></QueryClientProvider>
