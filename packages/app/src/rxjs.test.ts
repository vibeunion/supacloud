import { describe, expect, test } from "bun:test";
import { Observable, Subject } from "rxjs";
import { computed, isSignal, signal, Injector, DestroyRef } from "@angular/core";
import { takeUntilDestroyed as nativeTakeUntilDestroyed } from "@angular/core/rxjs-interop";
import * as angular from "./angular";
import { createDestroyRef } from "./context";
import { takeUntilDestroyed, toScopedSignal } from "./rxjs";

describe("official Angular integration", () => {
  test("reexports native identities rather than a second reactive graph", () => {
    expect(angular.signal).toBe(signal);
    expect(angular.computed).toBe(computed);
    expect(angular.takeUntilDestroyed).toBe(nativeTakeUntilDestroyed);
    const value = angular.signal(2);
    expect(isSignal(value)).toBe(true);
    const doubled = angular.computed(() => value() * 2);
    value.set(3);
    expect(doubled()).toBe(6);
  });

  test("native injector destruction releases the native subscription", () => {
    const injector = Injector.create({ providers: [] });
    const events = new Subject<number>();
    const subscription = events.pipe(angular.takeUntilDestroyed(injector.get(DestroyRef))).subscribe();
    injector.destroy();
    expect(subscription.closed).toBe(true);
  });
});

describe("SupaCloud scope / Angular RxJS interoperability", () => {
  test("scope abort stops consumption before slow cleanup completes", async () => {
    const scope = createDestroyRef();
    const events = new Subject<number>();
    const values: number[] = [];
    const subscription = events.pipe(takeUntilDestroyed(scope)).subscribe((value) => values.push(value));
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    scope.onDestroy(() => wait);
    events.next(1);
    const done = scope.destroy();
    events.next(2);
    expect(subscription.closed).toBe(true);
    expect(values).toEqual([1]);
    release();
    await done;
  });

  test("a destroyed owner never starts a cold source", async () => {
    const scope = createDestroyRef();
    await scope.destroy();
    let starts = 0;
    const source = new Observable<void>(() => { starts++; });
    const subscription = source.pipe(takeUntilDestroyed(scope)).subscribe();
    expect(starts).toBe(0);
    expect(subscription.closed).toBe(true);
  });

  test("early unsubscription removes the scope registration", async () => {
    const scope = createDestroyRef();
    let teardowns = 0;
    const subscription = new Observable(() => () => { teardowns++; })
      .pipe(takeUntilDestroyed(scope)).subscribe();
    expect(scope._teardowns.length).toBe(1);
    subscription.unsubscribe();
    expect(scope._teardowns.length).toBe(0);
    await scope.destroy();
    expect(teardowns).toBe(1);
  });

  test("an onDestroy-only owner remains supported", () => {
    const callbacks = new Set<() => void | Promise<void>>();
    const scope = {
      onDestroy(callback: () => void | Promise<void>) {
        callbacks.add(callback);
        return () => { callbacks.delete(callback); };
      },
    };
    const subscription = new Subject<void>().pipe(takeUntilDestroyed(scope)).subscribe();
    for (const callback of [...callbacks]) callback();
    expect(subscription.closed).toBe(true);
    expect(callbacks.size).toBe(0);
  });

  test("official signals track native computed state and stop with their owner", async () => {
    const scope = createDestroyRef();
    const events = new Subject<number>();
    const state = toScopedSignal(events, { destroyRef: scope, initialValue: 0 });
    const doubled = computed(() => state() * 2);
    expect(isSignal(state)).toBe(true);
    expect(doubled()).toBe(0);
    events.next(4);
    expect(doubled()).toBe(8);
    await scope.destroy();
    events.next(9);
    expect(doubled()).toBe(8);
  });

  test("source errors remain visible on signal read", async () => {
    const scope = createDestroyRef();
    const events = new Subject<number>();
    const state = toScopedSignal(events, { destroyRef: scope, initialValue: 0 });
    const failure = new Error("source failed");
    events.error(failure);
    expect(() => state()).toThrow("source failed");
    await scope.destroy();
  });

  test("independent owners do not share subscription lifetimes", async () => {
    const a = createDestroyRef();
    const b = createDestroyRef();
    const source = new Subject<number>();
    const first = source.pipe(takeUntilDestroyed(a)).subscribe();
    const second = source.pipe(takeUntilDestroyed(b)).subscribe();
    await a.destroy();
    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    await b.destroy();
    expect(second.closed).toBe(true);
  });
});
