import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as angular from "@angular/core";
import { computed, assertInInjectionContext, assertNotInReactiveContext } from "./angular";
import { Observable, of } from "rxjs";
import { createDestroyRef } from "./context";
import { toScopedSignal } from "./rxjs";

test("Angular context assertions are the public native functions", () => {
  assert.equal(assertInInjectionContext, angular.assertInInjectionContext);
  assert.equal(assertNotInReactiveContext, angular.assertNotInReactiveContext);
});

test("scoped signal creation in a computed fails before subscribing or registering cleanup", async () => {
  const owner = createDestroyRef();
  let subscriptions = 0;
  const stream = new Observable<number>(() => { subscriptions++; });
  const invalid = computed(() => toScopedSignal(stream, { destroyRef: owner, initialValue: 0 }));
  try {
    assert.throws(() => invalid());
    assert.equal(subscriptions, 0);
    assert.equal(owner._teardowns.length, 0);
  } finally { await owner.destroy(); }
});

test("a scoped signal can be created once without an Angular injector and then derived", async () => {
  const owner = createDestroyRef();
  try {
    const state = toScopedSignal(of(4), { destroyRef: owner, initialValue: 0 });
    const doubled = computed(() => state() * 2);
    assert.equal(angular.isSignal(state), true);
    assert.equal(doubled(), 8);
  } finally { await owner.destroy(); }
});
