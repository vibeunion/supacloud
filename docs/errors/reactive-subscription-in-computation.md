# reactive-subscription-in-computation

A statically known Angular `toSignal`, `rxResource`, or SupaCloud `toScopedSignal`
call creates a subscription inside a computed/effect callback.

```ts
// Rejected: recreates an owner-bound subscription during computation.
const progress = computed(() => toScopedSignal(events, options)());
// Resolve ownership first; create once, then derive state.
const state = toScopedSignal(events, options);
const progress = computed(() => state());
```

This is not an automatic hoisting fix: scope, parameters and lifetime may change.
The compiler, CLI JSON and diagnostic/editor adapters share the same suggestion.
The scan covers identifiable import bindings and inline callbacks, not arbitrary
external wrappers or dynamic side effects. Runtime Angular checks remain active.
