<script lang="ts">
  import type { CommandScope } from "@supacloud/contracts/client";
  import type { Readable } from "svelte/store";
  import { createSvelteCommandScope } from "./index";
  let { expose, target, onNavigate }: {
    expose: (scope: CommandScope) => void;
    target?: Readable<string>;
    onNavigate?: (invalidate: () => void) => void | (() => void);
  } = $props();
  const initialOptions = () => ({
    ...(target ? { target } : {}), ...(onNavigate ? { onNavigate } : {}),
  });
  const scope = createSvelteCommandScope(initialOptions());
  const exposeInitialScope = () => expose(scope);
  exposeInitialScope();
</script>

<span>Mounted command scope</span>
