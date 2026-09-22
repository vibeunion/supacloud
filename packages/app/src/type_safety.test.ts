import { describe, expect, test } from "bun:test";
import { FormArray, FormControl, FormGroup } from "./forms";
import { InjectionToken } from "./token";
import { provideToken } from "./provider";
import type { CanActivateFn, CanDeactivateFn } from "./decorators";
import { inject, type EnvironmentInjector } from "./inject";
import { TestBed } from "./testing";
import { executeRoutePipeline } from "./route_pipeline";

describe("public type safety", () => {
  test("form reset and absent initial state agree with nullable values", () => {
    const control = new FormControl("initial");
    control.reset();
    expect(control.value).toBeNull();
    expect(new FormControl<string>().value).toBeNull();
    control.reset("restored");
    expect(control.value).toBe("restored");
  });

  test("complete form writes reject mismatched shape before mutation", () => {
    const group = new FormGroup({ name: new FormControl("initial"), age: new FormControl(1) });
    expect(() => group.setValue({ name: "changed" } as never)).toThrow(TypeError);
    expect(group.value).toEqual({ name: "initial", age: 1 });
    group.patchValue({ name: "changed" });
    expect(group.value).toEqual({ name: "changed", age: 1 });
    const array = new FormArray([new FormControl(1)]);
    expect(() => array.setValue([2, 3])).toThrow(TypeError);
    expect(array.value).toEqual([1]);
  });

  test("truthy values from untyped guards fail closed", async () => {
    let writes = 0;
    const result = await executeRoutePipeline({
      path: "/items", method: "POST",
      guards: [(() => "yes") as unknown as CanActivateFn],
      handler: () => { writes++; return {}; },
    }, { url: "/items", method: "POST" });
    expect(result.status).toBe(403);
    expect(writes).toBe(0);
  });
});

// Compiled by typecheck:test, not executed.
function negativeTypes(injector: EnvironmentInjector) {
  const name = new FormControl("initial");
  // @ts-expect-error Controls preserve their value type.
  name.setValue(1);
  // @ts-expect-error Partial writes cannot change the value type.
  name.patchValue(false);
  // @ts-expect-error Reset accepts only the control's value type or null.
  name.reset(1);
  // @ts-expect-error Reset can produce null.
  const nonNullable: string = name.value;
  const group = new FormGroup({ name, count: new FormControl(0) });
  // @ts-expect-error Complete writes require every key.
  group.setValue({ name: "updated" });
  // @ts-expect-error Patch values must match their controls.
  group.patchValue({ count: "wrong" });
  // @ts-expect-error Required controls cannot disappear from the typed value.
  group.removeControl("name");
  // @ts-expect-error Replacement controls preserve the named value type.
  group.setControl("name", new FormControl(1));
  const array = new FormArray([name]);
  // @ts-expect-error Array writes preserve their element type.
  array.setValue([1]);
  const token = new InjectionToken<{ name: string }>("config");
  provideToken(token, { name: "valid" });
  // @ts-expect-error The value must not widen the token's type.
  provideToken(token, { name: 1 });
  // @ts-expect-error Optional injection can return undefined.
  const required: { name: string } = inject(token, { optional: true });
  // @ts-expect-error Environment injector has the same optionality contract.
  const optionalGet: { name: string } = injector.get(token, { optional: true });
  // @ts-expect-error TestBed must not hide absent optional providers.
  const optionalTest: { name: string } = TestBed.inject(token, undefined, { optional: true });
  // @ts-expect-error Arbitrary truthy values must not authorize a route.
  const guard: CanActivateFn = () => "yes";
  // @ts-expect-error Async guards have the same return contract.
  const asyncGuard: CanDeactivateFn = async () => ({ allowed: true });

  void nonNullable;
  void required;
  void optionalGet;
  void optionalTest;
  void guard;
  void asyncGuard;
}

void negativeTypes;
