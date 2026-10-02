/**
 * Official Angular APIs for Angular applications. These are NOT the legacy
 * synchronous SupaCloud signal/effect implementations from the root entry.
 * Keep Angular external at build time so the consumer owns one runtime.
 */
export {
  computed, signal, linkedSignal, untracked, effect, isSignal,
  DestroyRef, Injector, InjectionToken, createEnvironmentInjector,
  runInInjectionContext, resource,
} from "@angular/core";
export type {
  Signal, WritableSignal, CreateSignalOptions, CreateComputedOptions,
  CreateEffectOptions, EffectRef, EnvironmentInjector, ResourceRef,
} from "@angular/core";
export {
  takeUntilDestroyed, toSignal, toObservable, rxResource,
} from "@angular/core/rxjs-interop";
export type {
  ToSignalOptions, ToObservableOptions, RxResourceOptions,
} from "@angular/core/rxjs-interop";
