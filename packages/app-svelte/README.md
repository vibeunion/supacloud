# @supacloud/app-svelte

Svelte 5 lifecycle binding for `@supacloud/contracts`. No Angular dependency.

```svelte
<script lang="ts">
  import { createSvelteCommandScope } from "@supacloud/app-svelte";

  // Call during component initialization, not in an event handler or after await.
  const scope = createSvelteCommandScope();
  let state = $state("idle");

  async function readReceipt(operationId: string) {
    const attempt = scope.begin(operationId);
    const response = await fetch(`/receipts/${encodeURIComponent(operationId)}`, {
      signal: attempt.signal,
    });
    if (!response.ok) return;
    // Decode and match the real receipt before treating the operation as confirmed.
    attempt.commit(() => { state = "receipt-available"; });
  }
</script>
```

Unmounting aborts the attempt and prevents late commits. It deliberately **does not
remove persistent locks**, since cancellation cannot establish whether a write
committed. Pass `attempt.isCurrent` to `locks.release(target, operationId, ...)`;
never release in an unconditional `finally` or an `onDestroy` callback.

Restored locks can be resolved using the server command's `lookupByReference`.
Storage and Web Locks access must occur in the browser (for example in `onMount`),
not during SvelteKit server rendering.

For reused components, pass `target: Readable<string>` containing tenant, actor
and resource identity. Changes invalidate old attempts even before another
operation starts. `onNavigate(invalidate)` binds a host router hook and can return
an unsubscribe function. Both bindings are cleaned up at destruction.
With SvelteKit, pass `onNavigate: (invalidate) => beforeNavigate(() => invalidate())`;
`toStore(() => JSON.stringify([tenantId, actorId, page.params.id]))` adapts page state.
Registration belongs in component initialization. A cancelled navigation still
invalidates conservatively. Without these bindings, call `scope.invalidate()`
explicitly when the operation's target or authorization context changes.

## Acceptance

```sh
bun run typecheck
bun run typecheck:test
bun test
bun run build
bun run test:browser
```

Open the printed localhost URL. `#result` must report `ok: true`. The harness mounts
and unmounts real Svelte components, delays the old request completion, restores
the persistent lock, and checks both stale-release prevention and exclusive
acquisition using native localStorage and Web Locks. It also switches targets
without unmounting and verifies navigation invalidation and cleanup. It tests
the router-hook contract, not a complete SvelteKit router or customer auth flow.

The harness is test-only; it is not an application UI or a production endpoint.
See [migration and recovery](../../docs/command-migration.md).
