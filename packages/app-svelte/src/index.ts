import { onDestroy } from "svelte";
import type { Readable } from "svelte/store";
import { createCommandScope, type CommandScope } from "@supacloud/contracts/client";

/** Call during component initialization. Destruction cancels work, never persistent locks. */
export function createSvelteCommandScope(options: {
  /** Include tenant, actor and resource identity; toStore() adapts SvelteKit page state. */
  target?: Readable<string>;
  /** Bind beforeNavigate or another host router during component initialization. */
  onNavigate?(invalidate: () => void): void | (() => void);
} = {}): CommandScope {
  const scope = createCommandScope();
  let previous: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let unbind: void | (() => void);
  onDestroy(() => {
    scope.destroy();
    unsubscribe?.();
    if (typeof unbind === "function") unbind();
  });
  try {
    unsubscribe = options.target?.subscribe((target) => {
      if (previous !== target) scope.invalidate();
      previous = target;
    });
    unbind = options.onNavigate?.(() => scope.invalidate());
  } catch (error) {
    scope.destroy();
    unsubscribe?.();
    throw error;
  }
  return scope;
}
