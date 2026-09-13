<script module lang="ts">
  import { flushSync, mount, unmount } from "svelte";
  import { createDurableCommandLocks, createWebLockCoordinator } from "@supacloud/contracts/browser";
  import type { CommandScope } from "@supacloud/contracts/client";
  import { writable } from "svelte/store";
  import Probe from "./ScopeProbe.svelte";

  async function run() {
    const target = document.getElementById("app");
    if (!target) throw new Error("Missing mount point");
    if (!navigator.locks) throw new Error("Web Locks unavailable");
    const namespace = `supacloud-lifecycle-test-${crypto.randomUUID()}`;
    const locks = createDurableCommandLocks({
      namespace, storage: localStorage, coordinator: createWebLockCoordinator(navigator.locks),
    });
    const scopes: CommandScope[] = [];
    const expose = (scope: CommandScope) => { scopes.push(scope); };
    const first = flushSync(() => mount(Probe, { target, props: { expose } }));
    const oldScope = scopes[0];
    if (!oldScope) throw new Error("Old component did not initialize");
    const attempt = oldScope.begin("operation-1");
    await locks.acquire("webhook", attempt.operationId);
    const delayed = Promise.withResolvers<void>();
    let oldUpdates = 0;
    const oldCompletion = delayed.promise.then(async () => {
      const released = await locks.release("webhook", attempt.operationId, attempt.isCurrent);
      attempt.commit(() => { oldUpdates++; });
      return released;
    });
    await unmount(first);
    const second = flushSync(() => mount(Probe, { target, props: { expose } }));
    const newScope = scopes[1];
    if (!newScope) throw new Error("New component did not initialize");
    const restored = await locks.get("webhook");
    if (restored?.operationId !== "operation-1") throw new Error("Persistent lock was not restored");
    delayed.resolve();
    if (await oldCompletion) throw new Error("Old component released the new page's lock");
    if (!attempt.signal.aborted || oldUpdates !== 0 || !oldScope.destroyed) throw new Error("Stale scope committed");
    if ((await locks.get("webhook"))?.operationId !== "operation-1") throw new Error("Lock disappeared");
    const current = newScope.begin("operation-1");
    if (!await locks.release("webhook", current.operationId, current.isCurrent)) throw new Error("Current owner cannot release");
    const outcomes = await Promise.all([locks.acquire("shared", "a"), locks.acquire("shared", "b")]);
    if (outcomes.filter((result) => result.acquired).length !== 1) throw new Error("Multiple owners acquired a lock");
    const owner = outcomes.find((result) => result.acquired);
    if (!owner) throw new Error("Missing lock owner");
    await locks.release("shared", owner.lock.operationId, current.isCurrent);
    await unmount(second);
    const route = writable("tenant-a:webhook-a");
    let navigate: () => void = () => { throw new Error("Navigation hook was not registered"); };
    let unbound = false;
    const reused = flushSync(() => mount(Probe, {
      target, props: { expose, target: route, onNavigate: (invalidate) => {
        navigate = invalidate;
        return () => { unbound = true; };
      } },
    }));
    const reusedScope = scopes[2];
    if (!reusedScope) throw new Error("Reused component did not initialize");
    const oldTarget = reusedScope.begin("operation-2");
    await locks.acquire("reused", oldTarget.operationId);
    route.set("tenant-a:webhook-b");
    if (reusedScope.destroyed || !oldTarget.signal.aborted || oldTarget.isCurrent()) throw new Error("Target change did not invalidate");
    if (await locks.release("reused", oldTarget.operationId, oldTarget.isCurrent)) throw new Error("Target change lost its lock");
    const beforeNavigation = reusedScope.begin("operation-3");
    navigate();
    if (!beforeNavigation.signal.aborted || beforeNavigation.commit(() => { oldUpdates++; })) throw new Error("Navigation did not invalidate");
    const recovery = reusedScope.begin("operation-2");
    if (!await locks.release("reused", recovery.operationId, recovery.isCurrent)) throw new Error("Restored operation could not release");
    await unmount(reused);
    if (!unbound) throw new Error("Navigation subscription leaked");
    return {
      ok: true, componentUnmount: true, signalAborted: true, staleStateBlocked: true,
      persistentLockRestored: true, staleReleaseBlocked: true, currentRelease: true, exclusiveAcquire: true,
      reusedComponentTarget: true, navigationInvalidation: true, navigationCleanup: true,
    };
  }
  void run().then(
    (result) => { const output = document.getElementById("result"); if (output) output.textContent = JSON.stringify(result); },
    (error: unknown) => {
      const output = document.getElementById("result");
      if (output) output.textContent = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unknown failure" });
    },
  );
</script>
